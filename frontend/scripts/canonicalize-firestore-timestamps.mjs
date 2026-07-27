#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const INCIDENT_COLLECTION = {
  name: "incidents",
  scalarFields: ["reported_at", "ingested_at", "last_mention_at"],
  arrayFields: [{ name: "mentions", timestampField: "at" }],
};

const EXTRACTION_COLLECTION = {
  name: "extractions",
  scalarFields: ["reported_at", "ingested_at", "segment_start_utc"],
  arrayFields: [],
};

const COLLECTIONS = [
  INCIDENT_COLLECTION,
];

function parseArguments(argv) {
  const options = {
    apply: false,
    backup: null,
    confirmProject: null,
    includeExtractions: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--backup") {
      options.backup = argv[++index] || null;
    } else if (argument === "--confirm-project") {
      options.confirmProject = argv[++index] || null;
    } else if (argument === "--include-extractions") {
      options.includeExtractions = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.apply && !options.backup) {
    throw new Error("--apply requires --backup so every changed value is recoverable");
  }
  if (options.apply && !options.confirmProject) {
    throw new Error("--apply requires --confirm-project <Firebase project ID>");
  }
  return options;
}

function initializeFirebase() {
  if (getApps().length > 0) return;
  const projectId = process.env.FIREBASE_PROJECT_ID
    || process.env.GCLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT;
  const json = process.env.FIREBASE_ADMIN_KEY;
  initializeApp({
    credential: json ? cert(JSON.parse(json)) : applicationDefault(),
    ...(projectId ? { projectId } : {}),
  });
}

function valueKind(value) {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (value instanceof Date) return "date";
  if (typeof value === "object" && typeof value.toMillis === "function") {
    return "firestore-timestamp";
  }
  return typeof value;
}

function millisFromValue(value) {
  if (typeof value === "string") {
    let candidate = value.trim();
    if (!candidate) return null;
    if (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(candidate)
      && !candidate.endsWith("Z")
      && !/[+-]\d{2}:?\d{2}$/.test(candidate)
    ) {
      candidate += "Z";
    }
    const millis = Date.parse(candidate);
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
  }
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object" && typeof value.toMillis === "function") {
    const millis = Number(value.toMillis());
    return Number.isFinite(millis) ? millis : null;
  }
  if (value && typeof value === "object" && "seconds" in value) {
    const seconds = Number(value.seconds);
    return Number.isFinite(seconds) ? seconds * 1_000 : null;
  }
  return null;
}

function canonicalTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return { status: "missing" };
  }
  const millis = millisFromValue(value);
  const earliest = Date.UTC(2000, 0, 1);
  const latest = Date.now() + 366 * 24 * 60 * 60 * 1_000;
  if (millis === null || millis < earliest || millis > latest) {
    return { status: "invalid" };
  }
  const canonical = new Date(millis).toISOString().replace(/Z$/, "+00:00");
  return {
    status: typeof value === "string" && value === canonical ? "canonical" : "change",
    value: canonical,
  };
}

function backupValue(value) {
  if (value && typeof value === "object" && typeof value.toMillis === "function") {
    return {
      type: "firestore-timestamp",
      seconds: Number(value.seconds),
      nanoseconds: Number(value.nanoseconds),
    };
  }
  if (value instanceof Date) {
    return { type: "date", value: value.toISOString() };
  }
  return { type: valueKind(value), value };
}

function increment(record, key) {
  record[key] = (record[key] || 0) + 1;
}

async function scanCollection(db, definition, report, mutations) {
  const projectedFields = [
    ...definition.scalarFields,
    ...definition.arrayFields.map(({ name }) => name),
  ];
  const stream = db.collection(definition.name).select(...projectedFields).stream();
  for await (const snapshot of stream) {
    report.scanned[definition.name] += 1;
    const data = snapshot.data();
    const update = {};
    const changes = [];

    for (const field of definition.scalarFields) {
      const original = data[field];
      increment(report.valueKinds, `${definition.name}.${field}:${valueKind(original)}`);
      const result = canonicalTimestamp(original);
      if (result.status === "invalid") {
        report.invalidCount += 1;
        if (report.invalidSamples.length < 25) {
          report.invalidSamples.push({
            path: snapshot.ref.path,
            field,
            kind: valueKind(original),
          });
        }
      } else if (result.status === "change") {
        update[field] = result.value;
        changes.push({
          field,
          before: backupValue(original),
          after: result.value,
        });
      }
    }

    for (const arrayDefinition of definition.arrayFields) {
      const originalArray = data[arrayDefinition.name];
      if (!Array.isArray(originalArray)) continue;
      let changed = false;
      const nextArray = originalArray.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const original = entry[arrayDefinition.timestampField];
        const field = `${arrayDefinition.name}[${index}].${arrayDefinition.timestampField}`;
        increment(
          report.valueKinds,
          `${definition.name}.${arrayDefinition.name}.${arrayDefinition.timestampField}:${valueKind(original)}`
        );
        const result = canonicalTimestamp(original);
        if (result.status === "invalid") {
          report.invalidCount += 1;
          if (report.invalidSamples.length < 25) {
            report.invalidSamples.push({
              path: snapshot.ref.path,
              field,
              kind: valueKind(original),
            });
          }
          return entry;
        }
        if (result.status !== "change") return entry;
        changed = true;
        changes.push({
          field,
          before: backupValue(original),
          after: result.value,
        });
        return { ...entry, [arrayDefinition.timestampField]: result.value };
      });
      if (changed) update[arrayDefinition.name] = nextArray;
    }

    if (changes.length > 0) {
      report.documentsToChange[definition.name] += 1;
      report.valuesToChange += changes.length;
      mutations.push({
        ref: snapshot.ref,
        update,
        updateTime: snapshot.updateTime,
        backup: { path: snapshot.ref.path, changes },
      });
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const collections = options.includeExtractions
    ? [...COLLECTIONS, EXTRACTION_COLLECTION]
    : COLLECTIONS;
  initializeFirebase();
  const db = getFirestore();
  const projectId = db.projectId;
  if (options.apply && options.confirmProject !== projectId) {
    throw new Error(
      `Refusing to write project ${projectId}; --confirm-project was ${options.confirmProject}`
    );
  }

  const report = {
    projectId,
    mode: options.apply ? "apply" : "dry-run",
    scope: options.includeExtractions
      ? "public incidents and retired extraction archive"
      : "public incidents",
    scanned: Object.fromEntries(collections.map(({ name }) => [name, 0])),
    documentsToChange: Object.fromEntries(collections.map(({ name }) => [name, 0])),
    valuesToChange: 0,
    invalidCount: 0,
    invalidSamples: [],
    valueKinds: {},
  };
  const mutations = [];
  for (const definition of collections) {
    await scanCollection(db, definition, report, mutations);
  }

  if (options.apply) {
    const backupPath = path.resolve(options.backup);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      backupPath,
      `${JSON.stringify({
        schemaVersion: 1,
        projectId,
        createdAt: new Date().toISOString(),
        canonicalFormat: "UTC ISO-8601 string with millisecond precision and +00:00 offset",
        records: mutations.map((mutation) => mutation.backup),
      }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );

    const failures = [];
    const writer = db.bulkWriter();
    writer.onWriteError((error) => {
      if (error.failedAttempts < 3) return true;
      failures.push({
        path: error.documentRef.path,
        code: error.code,
        message: error.message,
      });
      return false;
    });
    for (const mutation of mutations) {
      writer.update(
        mutation.ref,
        mutation.update,
        { lastUpdateTime: mutation.updateTime }
      );
    }
    await writer.close();
    if (failures.length > 0) {
      throw new Error(`Backfill completed with write failures: ${JSON.stringify(failures)}`);
    }
    report.backupPath = backupPath;
    report.documentsChanged = mutations.length;
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

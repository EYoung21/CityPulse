// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const rulesSuite = emulatorHost ? describe : describe.skip;

rulesSuite("Firestore security rules", () => {
  let environment: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, portText] = emulatorHost!.split(":");
    environment = await initializeTestEnvironment({
      projectId: "demo-citypulse",
      firestore: {
        host,
        port: Number(portText),
        rules: readFileSync(resolve(process.cwd(), "../firestore.rules"), "utf8"),
      },
    });
  }, 30_000);

  beforeEach(async () => {
    await environment.clearFirestore();
  });

  afterAll(async () => {
    await environment?.cleanup();
  });

  it("keeps incident history and extractions off direct public Firestore reads", async () => {
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "incidents", "incident-1"), {
        raw_text: "scanner text",
      });
      await setDoc(doc(context.firestore(), "extractions", "extraction-1"), {
        raw_text: "private scanner text",
      });
    });

    const anonymous = environment.unauthenticatedContext().firestore();
    const ordinary = environment
      .authenticatedContext("owner", {
        email: "owner@example.com",
        email_verified: true,
        firebase: { sign_in_provider: "password" },
      })
      .firestore();
    const admin = environment
      .authenticatedContext("admin", {
        email: "eliyoung4now@gmail.com",
        email_verified: true,
        firebase: { sign_in_provider: "password" },
      })
      .firestore();

    await assertFails(getDoc(doc(anonymous, "incidents", "incident-1")));
    await assertFails(getDoc(doc(ordinary, "incidents", "incident-1")));
    await assertFails(getDoc(doc(admin, "incidents", "incident-1")));
    await assertFails(setDoc(doc(ordinary, "incidents", "incident-2"), {}));
    await assertFails(getDoc(doc(ordinary, "extractions", "extraction-1")));
    await assertSucceeds(getDoc(doc(admin, "extractions", "extraction-1")));
  });

  it("preserves server-owned commute delivery fields", async () => {
    const owner = environment
      .authenticatedContext("owner", {
        firebase: { sign_in_provider: "password" },
      })
      .firestore();
    const intruder = environment
      .authenticatedContext("intruder", {
        firebase: { sign_in_provider: "password" },
      })
      .firestore();
    const cleanSchedule = {
      uid: "owner",
      bucketKey: "wd:home:480",
      destLat: 39.95,
      destLng: -75.16,
      destLabel: "Home",
      matchedCategory: "home",
      typicalDepartureMinute: 480,
      typicalDurationMin: 25,
      isWeekend: false,
      confidence: 0.8,
      tz: "America/New_York",
      updatedAt: 100,
    };

    await assertSucceeds(
      setDoc(doc(owner, "commuteSchedules", "owner-clean"), cleanSchedule)
    );
    await assertFails(
      setDoc(doc(owner, "commuteSchedules", "owner-forged"), {
        ...cleanSchedule,
        fireClaimYmd: "2026-07-20",
        fireClaimUntilMs: 999_999,
        fireClaimToken: "forged",
      })
    );

    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "commuteSchedules", "owner-server"), {
        ...cleanSchedule,
        lastFiredYmd: "2026-07-19",
        lastFiredAtMs: 90,
        fireClaimYmd: "2026-07-20",
        fireClaimUntilMs: 999_999,
        fireClaimToken: "server-lease",
      });
    });

    await assertSucceeds(
      updateDoc(doc(owner, "commuteSchedules", "owner-server"), {
        updatedAt: 200,
      })
    );
    await assertFails(
      updateDoc(doc(owner, "commuteSchedules", "owner-server"), {
        fireClaimToken: "client-overwrite",
      })
    );
    await assertFails(
      getDoc(doc(intruder, "commuteSchedules", "owner-server"))
    );
    await assertFails(
      deleteDoc(doc(intruder, "commuteSchedules", "owner-server"))
    );
    await assertSucceeds(
      deleteDoc(doc(owner, "commuteSchedules", "owner-server"))
    );
  });

  it("allows owners to inspect or revoke server-created alerts without rewriting them", async () => {
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "pushSubscriptions", "sub-1"), {
        uid: "owner",
        endpoint: "https://push.example/secret",
      });
      await setDoc(doc(context.firestore(), "keywordWatches", "watch-1"), {
        uid: "owner",
        keyword: "shots",
      });
    });
    const owner = environment.authenticatedContext("owner").firestore();
    const intruder = environment.authenticatedContext("intruder").firestore();

    await assertSucceeds(getDoc(doc(owner, "pushSubscriptions", "sub-1")));
    await assertFails(
      updateDoc(doc(owner, "pushSubscriptions", "sub-1"), { endpoint: "https://evil.example" })
    );
    await assertFails(getDoc(doc(intruder, "pushSubscriptions", "sub-1")));
    await assertSucceeds(deleteDoc(doc(owner, "pushSubscriptions", "sub-1")));

    await assertSucceeds(getDoc(doc(owner, "keywordWatches", "watch-1")));
    await assertFails(
      updateDoc(doc(owner, "keywordWatches", "watch-1"), { keyword: "anything" })
    );
    await assertFails(getDoc(doc(intruder, "keywordWatches", "watch-1")));
    await assertSucceeds(deleteDoc(doc(owner, "keywordWatches", "watch-1")));
  });
});

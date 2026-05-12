import { permanentRedirect } from "next/navigation";

/** Canonical API documentation lives on `/use-cases/api` (marketing shell + `ApiDocsSection`). */
export default function ApiDocsRedirectPage() {
  permanentRedirect("/use-cases/api");
}

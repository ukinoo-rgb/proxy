/**
 * JWT auth for Google APIs (GA4, Search Console) using GOOGLE_SERVICE_ACCOUNT_JSON env.
 * Local dev: if env is unset, can read from file via GOOGLE_SERVICE_ACCOUNT_PATH (never in production).
 */

import fs from "fs";
import path from "path";
import { google } from "googleapis";

const SCOPES_GA4 = ["https://www.googleapis.com/auth/analytics.readonly"];
const SCOPES_GSC = ["https://www.googleapis.com/auth/webmasters.readonly"];

const DEFAULT_LOCAL_CREDENTIALS_PATH = "proximity-learning-ad7b59846f31.json";

export interface ServiceAccountCreds {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

function loadCredsFromFile(): ServiceAccountCreds {
  const filePath =
    process.env.GOOGLE_SERVICE_ACCOUNT_PATH ||
    path.join(process.cwd(), DEFAULT_LOCAL_CREDENTIALS_PATH);
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Service account JSON not found at ${resolved}. Place credentials at ${DEFAULT_LOCAL_CREDENTIALS_PATH} or set GOOGLE_SERVICE_ACCOUNT_PATH.`
    );
  }
  const raw = fs.readFileSync(resolved, "utf-8");
  try {
    return JSON.parse(raw) as ServiceAccountCreds;
  } catch {
    throw new Error(`Failed to parse ${resolved}. Use valid JSON.`);
  }
}

function getCreds(): ServiceAccountCreds {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw && typeof raw === "string" && raw.trim().length > 0) {
    try {
      return JSON.parse(raw) as ServiceAccountCreds;
    } catch {
      // In development, fall back to file if env var is malformed (e.g. quoting/newlines in .env)
      if (process.env.NODE_ENV !== "production") {
        try {
          return loadCredsFromFile();
        } catch {
          // rethrow the JSON parse error so user knows the env var is the problem
        }
      }
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_JSON is invalid JSON. Use scripts/env-from-json.ts to convert your .json file to one line, or remove it and use the file in dev."
      );
    }
  }
  // Local dev only: read from file (never in production)
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not set. In production, set it to your service account JSON (single-line)."
    );
  }
  return loadCredsFromFile();
}

/** Auth client for GA4 (Analytics Data API) */
export function getGA4Auth() {
  const creds = getCreds();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES_GA4,
  });
  return auth;
}

/** Auth client for Search Console */
export function getGSCAuth() {
  const creds = getCreds();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES_GSC,
  });
  return auth;
}

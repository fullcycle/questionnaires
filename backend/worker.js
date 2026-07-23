const DEFAULT_ALLOWED_ORIGIN = "https://fullcycle.github.io";
const DEFAULT_DROPBOX_FOLDER =
  "/questionnairesSectionInfo/Essais questionnaire automatisé";
const MAX_PAYLOAD_BYTES = 256 * 1024;

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function safePathPart(value, fallback) {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized.slice(0, 60) || fallback;
}

function validateSubmission(payload) {
  if (!payload || payload.format !== "interro-csharp-reponses") {
    return "Format de remise non reconnu.";
  }
  if (
    !payload.interrogation ||
    typeof payload.interrogation.id !== "string" ||
    payload.interrogation.id.length > 100
  ) {
    return "Questionnaire non reconnu.";
  }
  if (
    !payload.eleve ||
    typeof payload.eleve.nomComplet !== "string" ||
    payload.eleve.nomComplet.trim().length < 2 ||
    payload.eleve.nomComplet.length > 80
  ) {
    return "Le nom de l’élève est manquant ou invalide.";
  }
  if (
    !Array.isArray(payload.reponses) ||
    payload.reponses.length < 1 ||
    payload.reponses.length > 50
  ) {
    return "Les réponses sont manquantes ou invalides.";
  }
  return null;
}

async function getDropboxAccessToken(env) {
  if (
    !env.DROPBOX_APP_KEY ||
    !env.DROPBOX_APP_SECRET ||
    !env.DROPBOX_REFRESH_TOKEN
  ) {
    throw new Error("Dropbox n’est pas encore configuré.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.DROPBOX_REFRESH_TOKEN,
  });
  const credentials = btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`);
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`Autorisation Dropbox refusée (${response.status}).`);
  }
  const token = await response.json();
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new Error("Dropbox n’a pas fourni de jeton d’accès.");
  }
  return token.access_token;
}

async function uploadSubmission(payload, rawJson, env) {
  const accessToken = await getDropboxAccessToken(env);
  const folder = (env.DROPBOX_FOLDER_PATH || DEFAULT_DROPBOX_FOLDER).replace(
    /\/+$/,
    "",
  );
  const student = safePathPart(payload.eleve.nomComplet, "eleve");
  const studentClass = safePathPart(
    typeof payload.eleve.classe === "string" ? payload.eleve.classe : "",
    "sans-classe",
  );
  const questionnaire = safePathPart(
    payload.interrogation.id,
    "questionnaire",
  );
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}__${studentClass}__${student}__${questionnaire}.json`;
  const path = `${folder}/${filename}`;

  const response = await fetch(
    "https://content.dropboxapi.com/2/files/upload",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({
          path,
          mode: "add",
          autorename: true,
          mute: false,
          strict_conflict: false,
        }),
      },
      body: rawJson,
    },
  );
  if (!response.ok) {
    throw new Error(`Enregistrement Dropbox refusé (${response.status}).`);
  }
  return filename;
}

async function handleSubmit(request, env) {
  const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  const origin = request.headers.get("Origin");
  const cors = corsHeaders(allowedOrigin);

  if (origin !== allowedOrigin) {
    return jsonResponse(
      { ok: false, message: "Origine non autorisée." },
      403,
    );
  }

  const declaredLength = Number(request.headers.get("Content-Length") || "0");
  if (declaredLength > MAX_PAYLOAD_BYTES) {
    return jsonResponse(
      { ok: false, message: "Remise trop volumineuse." },
      413,
      cors,
    );
  }

  let rawJson;
  let payload;
  try {
    rawJson = await request.text();
    if (new TextEncoder().encode(rawJson).byteLength > MAX_PAYLOAD_BYTES) {
      return jsonResponse(
        { ok: false, message: "Remise trop volumineuse." },
        413,
        cors,
      );
    }
    payload = JSON.parse(rawJson);
  } catch {
    return jsonResponse(
      { ok: false, message: "Remise JSON invalide." },
      400,
      cors,
    );
  }

  const validationError = validateSubmission(payload);
  if (validationError) {
    return jsonResponse(
      { ok: false, message: validationError },
      400,
      cors,
    );
  }

  try {
    const filename = await uploadSubmission(payload, rawJson, env);
    return jsonResponse(
      {
        ok: true,
        filename,
        message: "Les réponses ont bien été envoyées.",
      },
      201,
      cors,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Impossible d’enregistrer la remise.";
    return jsonResponse({ ok: false, message }, 502, cors);
  }
}

function htmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function handleOauthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("dropbox_oauth_state="))
    ?.slice("dropbox_oauth_state=".length);

  if (!code || !state || !cookieState || state !== cookieState) {
    return new Response("Autorisation Dropbox invalide.", { status: 400 });
  }
  if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) {
    return new Response("Application Dropbox non configurée.", {
      status: 503,
    });
  }

  const redirectUri = `${url.origin}/oauth/callback`;
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(
        `${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`,
      )}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const result = await response.json();
  if (!response.ok || typeof result.refresh_token !== "string") {
    const reason =
      typeof result.error_description === "string"
        ? result.error_description
        : `Dropbox a refusé l’autorisation (${response.status}).`;
    return new Response(htmlEscape(reason), { status: 502 });
  }

  const refreshToken = htmlEscape(result.refresh_token);
  return new Response(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="robots" content="noindex"><title>Dropbox autorisé</title><style>body{font:16px system-ui;max-width:720px;margin:60px auto;padding:24px;color:#183153}code{display:block;overflow-wrap:anywhere;padding:16px;background:#eef4ff;border-radius:10px}</style><h1>Dropbox est autorisé</h1><p>Copiez ce jeton dans le secret du service, puis fermez cette page.</p><code>${refreshToken}</code></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie":
          "dropbox_oauth_state=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      },
    },
  );
}

function handleOauthStart(request, env) {
  const url = new URL(request.url);
  const setupSecret = url.searchParams.get("setup");
  if (
    !env.SETUP_SECRET ||
    setupSecret !== env.SETUP_SECRET ||
    !env.DROPBOX_APP_KEY
  ) {
    return new Response("Accès refusé.", { status: 403 });
  }
  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}/oauth/callback`;
  const authorize = new URL("https://www.dropbox.com/oauth2/authorize");
  authorize.searchParams.set("client_id", env.DROPBOX_APP_KEY);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("token_access_type", "offline");
  authorize.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Cache-Control": "no-store",
      "Set-Cookie": `dropbox_oauth_state=${state}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

function homePage() {
  return new Response(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Questionnaires Section Info</title><style>:root{font-family:Arial,sans-serif;color:#17305d;background:#edf4ff}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;box-sizing:border-box}main{width:min(620px,100%);box-sizing:border-box;padding:44px;border:1px solid #c9d8ee;border-radius:22px;background:#fff;box-shadow:0 20px 55px rgba(23,48,93,.12)}small{color:#2766c7;font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1{font-size:clamp(2rem,6vw,3.2rem);line-height:1.03;margin:10px 0 18px}p{color:#52657f;line-height:1.65}.status{color:#17603c;font-weight:700;margin-top:28px}</style><main><small>Service de remise</small><h1>Questionnaires Section Info</h1><p>Ce service sécurisé reçoit les réponses des questionnaires et les classe dans le dossier privé prévu à cet effet.</p><p class="status">● Service actif</p></main></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "questionnaire-submission",
        dropboxConfigured: Boolean(
          env.DROPBOX_APP_KEY &&
            env.DROPBOX_APP_SECRET &&
            env.DROPBOX_REFRESH_TOKEN,
        ),
      });
    }

    if (url.pathname === "/submit" && request.method === "OPTIONS") {
      if (request.headers.get("Origin") !== allowedOrigin) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowedOrigin),
      });
    }

    if (url.pathname === "/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }

    if (url.pathname === "/oauth/start" && request.method === "GET") {
      return handleOauthStart(request, env);
    }

    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      return handleOauthCallback(request, env);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return homePage();
    }

    return jsonResponse({ ok: false, message: "Ressource introuvable." }, 404);
  },
};

export default worker;

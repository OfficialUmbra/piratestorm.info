const ONLINE_TIMEOUT_SECONDS = 5 * 60;

const MAX_VISITOR_ID_LENGTH = 100;
const MIN_VISITOR_ID_LENGTH = 10;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();

    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }

  return null;
}

function normalizeVisitorId(value) {
  if (typeof value !== "string") {
    return null;
  }

  const visitorId = value.trim();

  if (
    visitorId.length < MIN_VISITOR_ID_LENGTH ||
    visitorId.length > MAX_VISITOR_ID_LENGTH
  ) {
    return null;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(visitorId)) {
    return null;
  }

  return visitorId;
}

async function getCurrentUser(request, env) {
  const sessionId = getCookie(request, "ps_session");

  if (!sessionId) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  const user = await env.DB.prepare(`
    SELECT
      users.id,
      users.username,
      users.server,
      users.role
    FROM sessions
    JOIN users
      ON users.id = sessions.user_id
    WHERE sessions.id = ?
      AND sessions.expires_at > ?
      AND LOWER(TRIM(users.username)) NOT LIKE 'deleteduser_%'
      AND LOWER(TRIM(users.username)) NOT LIKE 'deleted user%'
      AND LOWER(TRIM(users.username)) NOT LIKE 'deleted_user%'
      AND LOWER(TRIM(users.username)) NOT LIKE 'deleted-user%'
    LIMIT 1
  `)
    .bind(sessionId, now)
    .first();

  return user || null;
}

async function cleanupOldPresence(env) {
  const cutoff =
    Math.floor(Date.now() / 1000) -
    ONLINE_TIMEOUT_SECONDS;

  await env.DB.prepare(`
    DELETE FROM site_presence
    WHERE last_seen < ?
  `)
    .bind(cutoff)
    .run();
}

async function getRegisteredCount(env) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM users
    WHERE LOWER(TRIM(username)) NOT LIKE 'deleteduser_%'
      AND LOWER(TRIM(username)) NOT LIKE 'deleted user%'
      AND LOWER(TRIM(username)) NOT LIKE 'deleted_user%'
      AND LOWER(TRIM(username)) NOT LIKE 'deleted-user%'
  `).first();

  return Number(row?.total || 0);
}

async function getPresenceCounts(env) {
  const cutoff =
    Math.floor(Date.now() / 1000) -
    ONLINE_TIMEOUT_SECONDS;

  const row = await env.DB.prepare(`
    SELECT
      COUNT(
        DISTINCT CASE
          WHEN site_presence.user_id IS NULL
          THEN site_presence.visitor_id
        END
      ) AS guests,

      COUNT(
        DISTINCT CASE
          WHEN site_presence.user_id IS NOT NULL
            AND users.id IS NOT NULL
          THEN site_presence.user_id
        END
      ) AS members

    FROM site_presence

    LEFT JOIN users
      ON users.id = site_presence.user_id
      AND LOWER(TRIM(users.username)) NOT LIKE 'deleteduser_%'
      AND LOWER(TRIM(users.username)) NOT LIKE 'deleted user%'
      AND LOWER(TRIM(users.username)) NOT LIKE 'deleted_user%'
      AND LOWER(TRIM(users.username)) NOT LIKE 'deleted-user%'

    WHERE site_presence.last_seen >= ?
  `)
    .bind(cutoff)
    .first();

  const guests = Number(row?.guests || 0);
  const members = Number(row?.members || 0);

  return {
    guests,
    members,
    online: guests + members
  };
}

async function getSiteStatus(env) {
  await cleanupOldPresence(env);

  const [
    presence,
    registered
  ] = await Promise.all([
    getPresenceCounts(env),
    getRegisteredCount(env)
  ]);

  return {
    online: presence.online,
    guests: presence.guests,
    members: presence.members,
    registered
  };
}

/*
  GET
  ----
  Liefert ausschließlich die aktuellen Zahlen.

  GET erzeugt und verändert keine Presence-Einträge.
*/
export async function onRequestGet(context) {
  const { env } = context;

  try {
    if (!env.DB) {
      return json(
        {
          ok: false,
          error: "Database binding missing."
        },
        500
      );
    }

    const status = await getSiteStatus(env);

    return json({
      ok: true,
      ...status,
      timeout_seconds: ONLINE_TIMEOUT_SECONDS
    });
  } catch (error) {
    console.error(
      "Site status GET error:",
      error
    );

    return json(
      {
        ok: false,
        error: "Internal server error."
      },
      500
    );
  }
}

/*
  POST
  ----
  Heartbeat für die aktuelle geöffnete Webseite.

  Body:

  {
    "visitor_id": "page_xxxxx"
  }

  Diese visitor_id wird NICHT in localStorage gespeichert.

  Das Frontend erzeugt beim Laden der Seite einmal eine zufällige
  ID ausschließlich im JavaScript-Arbeitsspeicher.

  Beim Schließen der Seite geht diese ID verloren.
*/
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.DB) {
      return json(
        {
          ok: false,
          error: "Database binding missing."
        },
        500
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        {
          ok: false,
          error: "Invalid JSON body."
        },
        400
      );
    }

    const visitorId =
      normalizeVisitorId(body?.visitor_id);

    if (!visitorId) {
      return json(
        {
          ok: false,
          error: "Invalid visitor ID."
        },
        400
      );
    }

    const currentUser =
      await getCurrentUser(request, env);

    const now =
      Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT INTO site_presence (
        visitor_id,
        user_id,
        last_seen,
        created_at
      )
      VALUES (
        ?,
        ?,
        ?,
        ?
      )

      ON CONFLICT(visitor_id)
      DO UPDATE SET
        user_id = excluded.user_id,
        last_seen = excluded.last_seen
    `)
      .bind(
        visitorId,
        currentUser?.id || null,
        now,
        now
      )
      .run();

    await cleanupOldPresence(env);

    const status =
      await getSiteStatus(env);

    return json({
      ok: true,

      presence: {
        active: true,

        logged_in:
          Boolean(currentUser),

        user_id:
          currentUser?.id || null,

        server:
          currentUser
            ? (
                currentUser.role === "admin"
                  ? "ADMIN"
                  : currentUser.server
              )
            : null
      },

      ...status,

      timeout_seconds:
        ONLINE_TIMEOUT_SECONDS
    });
  } catch (error) {
    console.error(
      "Site status POST error:",
      error
    );

    return json(
      {
        ok: false,
        error: "Internal server error."
      },
      500
    );
  }
}

/*
  DELETE
  ------
  Entfernt die temporäre Presence-ID sofort.

  Body:

  {
    "visitor_id": "page_xxxxx"
  }

  Falls der Browser den Request beim Schließen der Seite
  nicht mehr abschicken kann, verschwindet der Eintrag
  automatisch spätestens nach fünf Minuten.
*/
export async function onRequestDelete(context) {
  const { request, env } = context;

  try {
    if (!env.DB) {
      return json(
        {
          ok: false,
          error: "Database binding missing."
        },
        500
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        {
          ok: false,
          error: "Invalid JSON body."
        },
        400
      );
    }

    const visitorId =
      normalizeVisitorId(body?.visitor_id);

    if (!visitorId) {
      return json(
        {
          ok: false,
          error: "Invalid visitor ID."
        },
        400
      );
    }

    await env.DB.prepare(`
      DELETE FROM site_presence
      WHERE visitor_id = ?
    `)
      .bind(visitorId)
      .run();

    await cleanupOldPresence(env);

    const status =
      await getSiteStatus(env);

    return json({
      ok: true,
      removed: true,
      ...status
    });
  } catch (error) {
    console.error(
      "Site status DELETE error:",
      error
    );

    return json(
      {
        ok: false,
        error: "Internal server error."
      },
      500
    );
  }
}

export async function onRequestPut() {
  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
}

export async function onRequestPatch() {
  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
}

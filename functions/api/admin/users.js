const ALLOWED_SERVERS = [
  "DE1",
  "EU1",
  "EU2",
  "EU3",
  "EU4",
  "AR1",
  "LA1",
  "USA1"
];

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

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
    LIMIT 1
  `)
    .bind(sessionId, now)
    .first();

  return user || null;
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value || "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_LIMIT);
}

function normalizeOffset(value) {
  const parsed = Number.parseInt(value || "", 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

function normalizeSort(value) {
  switch ((value || "").toLowerCase()) {
    case "name":
    case "username":
      return "username";

    case "oldest":
      return "oldest";

    case "newest":
    case "date":
    case "registered":
    default:
      return "newest";
  }
}

function getOrderBy(sort) {
  switch (sort) {
    case "username":
      return "LOWER(users.username) ASC, users.id ASC";

    case "oldest":
      return "users.id ASC";

    case "newest":
    default:
      return "users.id DESC";
  }
}

function displayServer(user) {
  if (user.role === "admin") {
    return "ADMIN";
  }

  return user.server || "";
}

async function getUserTableColumns(env) {
  const result = await env.DB.prepare(`
    PRAGMA table_info(users)
  `).all();

  return Array.isArray(result.results)
    ? result.results.map((column) => column.name)
    : [];
}

function findRegistrationColumn(columns) {
  const candidates = [
    "created_at",
    "registered_at",
    "registration_date",
    "created",
    "registered"
  ];

  for (const candidate of candidates) {
    if (columns.includes(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function onRequestGet(context) {
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

    const currentUser = await getCurrentUser(request, env);

    if (!currentUser) {
      return json(
        {
          ok: false,
          error: "Not logged in."
        },
        401
      );
    }

    if (currentUser.role !== "admin") {
      return json(
        {
          ok: false,
          error: "Admin access required."
        },
        403
      );
    }

    const url = new URL(request.url);

    const search = (url.searchParams.get("q") || "")
      .trim()
      .slice(0, 100);

    const requestedServer = (url.searchParams.get("server") || "")
      .trim()
      .toUpperCase();

    const sort = normalizeSort(url.searchParams.get("sort"));
    const limit = normalizeLimit(url.searchParams.get("limit"));
    const offset = normalizeOffset(url.searchParams.get("offset"));

    if (
      requestedServer &&
      requestedServer !== "ADMIN" &&
      !ALLOWED_SERVERS.includes(requestedServer)
    ) {
      return json(
        {
          ok: false,
          error: "Invalid server."
        },
        400
      );
    }

    /*
      Wir erkennen die Spalte für das Registrierungsdatum automatisch.

      Dadurch funktioniert der Endpoint auch dann weiter, wenn die
      users-Tabelle z.B. created_at oder registered_at verwendet.

      Falls keine entsprechende Spalte existiert, wird registered_at
      einfach als null zurückgegeben.
    */
    const userColumns = await getUserTableColumns(env);
    const registrationColumn = findRegistrationColumn(userColumns);

    const registrationSelect = registrationColumn
      ? `users.${registrationColumn} AS registered_at`
      : `NULL AS registered_at`;

    const conditions = [];
    const bindings = [];

    if (search) {
      conditions.push("LOWER(users.username) LIKE LOWER(?)");
      bindings.push(`%${search}%`);
    }

    if (requestedServer === "ADMIN") {
      conditions.push("users.role = 'admin'");
    } else if (requestedServer) {
      conditions.push("users.role != 'admin'");
      conditions.push("users.server = ?");
      bindings.push(requestedServer);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const orderBy = getOrderBy(sort);

    const countRow = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM users
      ${whereClause}
    `)
      .bind(...bindings)
      .first();

    const total = Number(countRow?.total || 0);

    const query = `
      SELECT
        users.id,
        users.username,
        users.server,
        users.role,
        ${registrationSelect}
      FROM users
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ?
      OFFSET ?
    `;

    const result = await env.DB.prepare(query)
      .bind(...bindings, limit, offset)
      .all();

    const users = (result.results || []).map((user) => ({
      id: user.id,
      username: user.username,
      server: displayServer(user),
      role: user.role,
      registered_at: user.registered_at ?? null
    }));

    return json({
      ok: true,

      users,

      pagination: {
        total,
        limit,
        offset,
        returned: users.length,
        has_more: offset + users.length < total
      },

      filters: {
        q: search,
        server: requestedServer || null,
        sort
      },

      registration_date_available: Boolean(registrationColumn)
    });
  } catch (error) {
    console.error("Admin users GET error:", error);

    return json(
      {
        ok: false,
        error: "Internal server error."
      },
      500
    );
  }
}

export async function onRequestPost() {
  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
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

export async function onRequestDelete() {
  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
}

const ALLOWED_CONTENT_TYPES = new Set([
  "forum",
  "chat",
  "whisper",
  "profile",
  "other"
]);

const ALLOWED_STATUSES = new Set([
  "open",
  "reviewing",
  "resolved",
  "rejected"
]);

const MAX_NAME_LENGTH = 150;
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCATION_LENGTH = 1000;
const MAX_REFERENCE_LENGTH = 500;
const MAX_REASON_LENGTH = 5000;
const MAX_ADMIN_NOTE_LENGTH = 5000;
const MAX_DECISION_LENGTH = 5000;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

function normalizeString(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function isValidEmail(email) {
  if (!email) {
    return false;
  }

  if (email.length > MAX_EMAIL_LENGTH) {
    return false;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

async function legalReportsTableExists(env) {
  const row = await env.DB.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'legal_content_reports'
    LIMIT 1
  `).first();

  return Boolean(row);
}

async function countOpenReports(env) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM legal_content_reports
    WHERE status IN ('open', 'reviewing')
  `).first();

  return Number(row?.total || 0);
}

async function hasRecentDuplicateReport(
  env,
  reporterUserId,
  reporterEmail,
  contentLocation
) {
  const since = Math.floor(Date.now() / 1000) - (60 * 10);

  let row;

  if (reporterUserId) {
    row = await env.DB.prepare(`
      SELECT id
      FROM legal_content_reports
      WHERE reporter_user_id = ?
        AND content_location = ?
        AND created_at >= ?
        AND status IN ('open', 'reviewing')
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(
        reporterUserId,
        contentLocation,
        since
      )
      .first();
  } else {
    row = await env.DB.prepare(`
      SELECT id
      FROM legal_content_reports
      WHERE LOWER(reporter_email) = LOWER(?)
        AND content_location = ?
        AND created_at >= ?
        AND status IN ('open', 'reviewing')
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(
        reporterEmail,
        contentLocation,
        since
      )
      .first();
  }

  return Boolean(row);
}

/*
  GET

  Öffentlich:
    Keine Liste sichtbar.

  Admin:
    - Liste aller Meldungen
    - Filter nach Status
    - einzelne Meldung über ?id=
    - offene Anzahl über ?count=1
*/
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

    if (!(await legalReportsTableExists(env))) {
      return json(
        {
          ok: false,
          error: "Legal reports table missing."
        },
        500
      );
    }

    const currentUser =
      await getCurrentUser(request, env);

    if (
      !currentUser ||
      currentUser.role !== "admin"
    ) {
      return json(
        {
          ok: false,
          error: "Admin access required."
        },
        currentUser ? 403 : 401
      );
    }

    const url = new URL(request.url);

    /*
      Nur Zähler für Admin-Badge.
    */
    if (url.searchParams.get("count") === "1") {
      const openCount =
        await countOpenReports(env);

      return json({
        ok: true,
        open_count: openCount
      });
    }

    /*
      Einzelne Meldung öffnen.
    */
    const id = Number.parseInt(
      url.searchParams.get("id") || "",
      10
    );

    if (Number.isFinite(id) && id > 0) {
      const report = await env.DB.prepare(`
        SELECT
          legal_content_reports.id,

          legal_content_reports.reporter_user_id,
          legal_content_reports.reporter_name,
          legal_content_reports.reporter_email,

          legal_content_reports.content_type,
          legal_content_reports.content_location,
          legal_content_reports.content_reference,

          legal_content_reports.reason,
          legal_content_reports.good_faith,

          legal_content_reports.status,
          legal_content_reports.admin_note,
          legal_content_reports.decision,

          legal_content_reports.created_at,
          legal_content_reports.updated_at,
          legal_content_reports.resolved_at,

          users.username AS registered_username,
          users.server AS registered_server,
          users.role AS registered_role

        FROM legal_content_reports

        LEFT JOIN users
          ON users.id =
             legal_content_reports.reporter_user_id

        WHERE legal_content_reports.id = ?

        LIMIT 1
      `)
        .bind(id)
        .first();

      if (!report) {
        return json(
          {
            ok: false,
            error: "Report not found."
          },
          404
        );
      }

      return json({
        ok: true,

        report: {
          ...report,

          good_faith:
            Boolean(report.good_faith),

          registered_server:
            report.registered_role === "admin"
              ? "ADMIN"
              : report.registered_server
        }
      });
    }

    const requestedStatus =
      normalizeString(
        url.searchParams.get("status") || "open",
        30
      ).toLowerCase();

    const status =
      requestedStatus === "all"
        ? "all"
        : requestedStatus;

    if (
      status !== "all" &&
      !ALLOWED_STATUSES.has(status)
    ) {
      return json(
        {
          ok: false,
          error: "Invalid status."
        },
        400
      );
    }

    const limit = normalizeLimit(
      url.searchParams.get("limit")
    );

    const offset = normalizeOffset(
      url.searchParams.get("offset")
    );

    const conditions = [];
    const bindings = [];

    if (status !== "all") {
      conditions.push(
        "legal_content_reports.status = ?"
      );

      bindings.push(status);
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

    const countRow =
      await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM legal_content_reports
        ${whereClause}
      `)
        .bind(...bindings)
        .first();

    const total =
      Number(countRow?.total || 0);

    const result =
      await env.DB.prepare(`
        SELECT
          legal_content_reports.id,

          legal_content_reports.reporter_user_id,
          legal_content_reports.reporter_name,
          legal_content_reports.reporter_email,

          legal_content_reports.content_type,
          legal_content_reports.content_location,
          legal_content_reports.content_reference,

          legal_content_reports.reason,
          legal_content_reports.good_faith,

          legal_content_reports.status,

          legal_content_reports.created_at,
          legal_content_reports.updated_at,
          legal_content_reports.resolved_at,

          users.username AS registered_username,
          users.server AS registered_server,
          users.role AS registered_role

        FROM legal_content_reports

        LEFT JOIN users
          ON users.id =
             legal_content_reports.reporter_user_id

        ${whereClause}

        ORDER BY
          CASE legal_content_reports.status
            WHEN 'open' THEN 1
            WHEN 'reviewing' THEN 2
            WHEN 'resolved' THEN 3
            WHEN 'rejected' THEN 4
            ELSE 5
          END,
          legal_content_reports.created_at DESC,
          legal_content_reports.id DESC

        LIMIT ?
        OFFSET ?
      `)
        .bind(
          ...bindings,
          limit,
          offset
        )
        .all();

    const reports =
      (result.results || []).map(
        (report) => ({
          ...report,

          good_faith:
            Boolean(report.good_faith),

          registered_server:
            report.registered_role === "admin"
              ? "ADMIN"
              : report.registered_server
        })
      );

    const openCount =
      await countOpenReports(env);

    return json({
      ok: true,

      reports,

      open_count: openCount,

      pagination: {
        total,
        limit,
        offset,
        returned: reports.length,
        has_more:
          offset + reports.length < total
      }
    });
  } catch (error) {
    console.error(
      "Legal reports GET error:",
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

  Darf auch OHNE Login verwendet werden.

  Benötigt:
  - reporter_name
  - reporter_email
  - content_type
  - content_location
  - reason
  - good_faith === true

  Optional:
  - content_reference
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

    if (!(await legalReportsTableExists(env))) {
      return json(
        {
          ok: false,
          error: "Legal reports table missing."
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

    const currentUser =
      await getCurrentUser(request, env);

    const reporterName =
      normalizeString(
        body?.reporter_name,
        MAX_NAME_LENGTH
      );

    const reporterEmail =
      normalizeString(
        body?.reporter_email,
        MAX_EMAIL_LENGTH
      ).toLowerCase();

    const contentType =
      normalizeString(
        body?.content_type,
        30
      ).toLowerCase();

    const contentLocation =
      normalizeString(
        body?.content_location,
        MAX_LOCATION_LENGTH
      );

    const contentReference =
      normalizeString(
        body?.content_reference,
        MAX_REFERENCE_LENGTH
      );

    const reason =
      normalizeString(
        body?.reason,
        MAX_REASON_LENGTH
      );

    const goodFaith =
      body?.good_faith === true;

    if (!reporterName) {
      return json(
        {
          ok: false,
          error: "Name is required."
        },
        400
      );
    }

    if (!isValidEmail(reporterEmail)) {
      return json(
        {
          ok: false,
          error: "A valid email address is required."
        },
        400
      );
    }

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return json(
        {
          ok: false,
          error: "Invalid content type."
        },
        400
      );
    }

    if (!contentLocation) {
      return json(
        {
          ok: false,
          error:
            "The exact location of the content is required."
        },
        400
      );
    }

    if (reason.length < 20) {
      return json(
        {
          ok: false,
          error:
            "Please explain why you believe the content is illegal."
        },
        400
      );
    }

    if (!goodFaith) {
      return json(
        {
          ok: false,
          error:
            "The good-faith declaration must be confirmed."
        },
        400
      );
    }

    /*
      Einfacher Duplicate-/Spam-Schutz:
      dieselbe Person + dieselbe Fundstelle innerhalb von
      10 Minuten nicht mehrfach als offen/reviewing.
    */
    const duplicate =
      await hasRecentDuplicateReport(
        env,
        currentUser?.id || null,
        reporterEmail,
        contentLocation
      );

    if (duplicate) {
      return json(
        {
          ok: false,
          error:
            "A report for this content was already submitted recently."
        },
        429
      );
    }

    const result =
      await env.DB.prepare(`
        INSERT INTO legal_content_reports (
          reporter_user_id,
          reporter_name,
          reporter_email,

          content_type,
          content_location,
          content_reference,

          reason,
          good_faith,

          status,
          created_at,
          updated_at
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          1,
          'open',
          strftime('%s','now'),
          strftime('%s','now')
        )
      `)
        .bind(
          currentUser?.id || null,
          reporterName,
          reporterEmail,

          contentType,
          contentLocation,
          contentReference || null,

          reason
        )
        .run();

    const reportId =
      result?.meta?.last_row_id ?? null;

    return json(
      {
        ok: true,

        submitted: true,

        report_id: reportId,

        message:
          "Your report has been submitted and will be reviewed."
      },
      201
    );
  } catch (error) {
    console.error(
      "Legal reports POST error:",
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
  PUT

  Nur Admin.

  Damit kannst du:
  - open
  - reviewing
  - resolved
  - rejected

  setzen und eine interne Notiz bzw. Entscheidung speichern.
*/
export async function onRequestPut(context) {
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

    const currentUser =
      await getCurrentUser(request, env);

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

    const id =
      Number.parseInt(body?.id, 10);

    if (
      !Number.isFinite(id) ||
      id <= 0
    ) {
      return json(
        {
          ok: false,
          error: "Invalid report ID."
        },
        400
      );
    }

    const status =
      normalizeString(
        body?.status,
        30
      ).toLowerCase();

    if (!ALLOWED_STATUSES.has(status)) {
      return json(
        {
          ok: false,
          error: "Invalid status."
        },
        400
      );
    }

    const adminNote =
      normalizeString(
        body?.admin_note,
        MAX_ADMIN_NOTE_LENGTH
      );

    const decision =
      normalizeString(
        body?.decision,
        MAX_DECISION_LENGTH
      );

    const existing =
      await env.DB.prepare(`
        SELECT id
        FROM legal_content_reports
        WHERE id = ?
        LIMIT 1
      `)
        .bind(id)
        .first();

    if (!existing) {
      return json(
        {
          ok: false,
          error: "Report not found."
        },
        404
      );
    }

    const isFinished =
      status === "resolved" ||
      status === "rejected";

    await env.DB.prepare(`
      UPDATE legal_content_reports
      SET
        status = ?,
        admin_note = ?,
        decision = ?,
        updated_at = strftime('%s','now'),
        resolved_at =
          CASE
            WHEN ? = 1
              THEN strftime('%s','now')
            ELSE NULL
          END
      WHERE id = ?
    `)
      .bind(
        status,
        adminNote || null,
        decision || null,
        isFinished ? 1 : 0,
        id
      )
      .run();

    const openCount =
      await countOpenReports(env);

    return json({
      ok: true,
      updated: true,
      id,
      status,
      open_count: openCount
    });
  } catch (error) {
    console.error(
      "Legal reports PUT error:",
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

    const currentUser =
      await getCurrentUser(request, env);

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

    /*
      Rechtliche Meldungen werden nicht einfach über die
      Oberfläche gelöscht.

      Sie sollen stattdessen als resolved oder rejected
      abgeschlossen werden.

      Eine spätere definierte Löschfrist bauen wir separat ein.
    */
    return json(
      {
        ok: false,
        error:
          "Legal reports cannot be deleted through this endpoint. Close them using a status instead."
      },
      405
    );
  } catch (error) {
    console.error(
      "Legal reports DELETE error:",
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

export async function onRequestPatch() {
  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
}

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

const SERVER_MAP = {
  "DE1": "DE1",
  "Deutschland 1": "DE1",

  "EU1": "EU1",
  "Europa 1": "EU1",
  "Europa1": "EU1",

  "EU2": "EU2",
  "Europa 2": "EU2",
  "Europa2": "EU2",

  "EU3": "EU3",
  "Europa 3": "EU3",
  "Europa3": "EU3",

  "EU4": "EU4",
  "Europa 4": "EU4",
  "Europa4": "EU4",

  "AR1": "AR1",
  "Arabien 1": "AR1",
  "Arabien1": "AR1",

  "LA1": "LA1",
  "Lateinamerika 1": "LA1",
  "Lateinamerika1": "LA1",

  "USA1": "USA1",
  "USA 1": "USA1"
};

const SERVER_FILTER_VALUES = {
  DE1: ["DE1", "Deutschland 1"],

  EU1: [
    "EU1",
    "Europa 1",
    "Europa1"
  ],

  EU2: [
    "EU2",
    "Europa 2",
    "Europa2"
  ],

  EU3: [
    "EU3",
    "Europa 3",
    "Europa3"
  ],

  EU4: [
    "EU4",
    "Europa 4",
    "Europa4"
  ],

  AR1: [
    "AR1",
    "Arabien 1",
    "Arabien1"
  ],

  LA1: [
    "LA1",
    "Lateinamerika 1",
    "Lateinamerika1"
  ],

  USA1: [
    "USA1",
    "USA 1"
  ]
};

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;


/*
  ----------------------------------------------------
  JSON RESPONSE
  ----------------------------------------------------
*/

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}


/*
  ----------------------------------------------------
  COOKIE
  ----------------------------------------------------
*/

function getCookie(
  request,
  name
) {
  const cookieHeader =
    request.headers.get("Cookie") || "";

  for (
    const part
    of cookieHeader.split(";")
  ) {
    const trimmed =
      part.trim();

    if (!trimmed) {
      continue;
    }

    const separatorIndex =
      trimmed.indexOf("=");

    if (
      separatorIndex === -1
    ) {
      continue;
    }

    const key =
      trimmed
        .slice(
          0,
          separatorIndex
        )
        .trim();

    const value =
      trimmed
        .slice(
          separatorIndex + 1
        )
        .trim();

    if (
      key === name
    ) {
      try {
        return decodeURIComponent(
          value
        );
      } catch {
        return value;
      }
    }
  }

  return null;
}


/*
  ----------------------------------------------------
  CURRENT USER
  ----------------------------------------------------
*/

async function getCurrentUser(
  request,
  env
) {
  const sessionId =
    getCookie(
      request,
      "ps_session"
    );

  if (!sessionId) {
    return null;
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  const user =
    await env.DB
      .prepare(`
        SELECT
          users.id,
          users.username,
          users.server,
          users.role
        FROM sessions
        JOIN users
          ON users.id =
             sessions.user_id
        WHERE sessions.id = ?
          AND sessions.expires_at > ?
        LIMIT 1
      `)
      .bind(
        sessionId,
        now
      )
      .first();

  return user || null;
}


/*
  ----------------------------------------------------
  LIMIT / OFFSET / SORT
  ----------------------------------------------------
*/

function normalizeLimit(value) {
  const parsed =
    Number.parseInt(
      value || "",
      10
    );

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    return DEFAULT_LIMIT;
  }

  return Math.min(
    parsed,
    MAX_LIMIT
  );
}

function normalizeOffset(value) {
  const parsed =
    Number.parseInt(
      value || "",
      10
    );

  if (
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    return 0;
  }

  return parsed;
}

function normalizeSort(value) {
  switch (
    (value || "")
      .toLowerCase()
  ) {
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
      return `
        LOWER(users.username) ASC,
        users.id ASC
      `;

    case "oldest":
      return `
        users.id ASC
      `;

    case "newest":
    default:
      return `
        users.id DESC
      `;
  }
}


/*
  ----------------------------------------------------
  SERVER DISPLAY
  ----------------------------------------------------
*/

function normalizeServer(
  server,
  role
) {
  if (
    role === "admin"
  ) {
    return "ADMIN";
  }

  const raw =
    String(
      server || ""
    ).trim();

  return (
    SERVER_MAP[raw] ||
    raw
  );
}


/*
  ----------------------------------------------------
  USERS TABLE
  ----------------------------------------------------
*/

async function getUserTableColumns(
  env
) {
  const result =
    await env.DB
      .prepare(`
        PRAGMA table_info(users)
      `)
      .all();

  return Array.isArray(
    result.results
  )
    ? result.results.map(
        column =>
          column.name
      )
    : [];
}

function findRegistrationColumn(
  columns
) {
  const candidates = [
    "created_at",
    "registered_at",
    "registration_date",
    "created",
    "registered"
  ];

  for (
    const candidate
    of candidates
  ) {
    if (
      columns.includes(
        candidate
      )
    ) {
      return candidate;
    }
  }

  return null;
}


/*
  ----------------------------------------------------
  FORUM-BAN
  ----------------------------------------------------
*/

async function expireOldForumBans(
  env
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  await env.DB
    .prepare(`
      UPDATE forum_bans
      SET active = 0
      WHERE active = 1
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `)
    .bind(now)
    .run();
}

function serializeForumBan(
  ban
) {
  if (!ban) {
    return null;
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  const expiresAt =
    ban.expires_at === null
      ? null
      : Number(
          ban.expires_at
        );

  return {
    id:
      Number(
        ban.id
      ),

    reason:
      ban.reason || "",

    banned_at:
      Number(
        ban.banned_at
      ),

    expires_at:
      expiresAt,

    permanent:
      expiresAt === null,

    remaining_seconds:
      expiresAt === null
        ? null
        : Math.max(
            0,
            expiresAt - now
          )
  };
}


/*
  ----------------------------------------------------
  GET /api/admin/users
  ----------------------------------------------------
*/

export async function onRequestGet(
  context
) {
  const {
    request,
    env
  } = context;

  try {

    /*
      DB BINDING
    */

    if (!env.DB) {
      return json(
        {
          ok: false,
          error:
            "Database binding missing."
        },
        500
      );
    }


    /*
      ADMIN AUTH
    */

    const currentUser =
      await getCurrentUser(
        request,
        env
      );

    if (!currentUser) {
      return json(
        {
          ok: false,
          error:
            "Not logged in."
        },
        401
      );
    }

    if (
      currentUser.role !==
      "admin"
    ) {
      return json(
        {
          ok: false,
          error:
            "Admin access required."
        },
        403
      );
    }


    /*
      ABGELAUFENE FORUM-BANNS
      DEAKTIVIEREN
    */

    await expireOldForumBans(
      env
    );


    /*
      QUERY PARAMETER
    */

    const url =
      new URL(
        request.url
      );

    const search =
      (
        url.searchParams
          .get("q") || ""
      )
        .trim()
        .slice(
          0,
          100
        );

    const requestedServer =
      (
        url.searchParams
          .get("server") || ""
      )
        .trim()
        .toUpperCase();

    const sort =
      normalizeSort(
        url.searchParams
          .get("sort")
      );

    const limit =
      normalizeLimit(
        url.searchParams
          .get("limit")
      );

    const offset =
      normalizeOffset(
        url.searchParams
          .get("offset")
      );


    /*
      SERVER VALIDIEREN
    */

    if (
      requestedServer &&
      requestedServer !==
        "ADMIN" &&
      !ALLOWED_SERVERS.includes(
        requestedServer
      )
    ) {
      return json(
        {
          ok: false,
          error:
            "Invalid server."
        },
        400
      );
    }


    /*
      REGISTRIERUNGSDATUM
      AUTOMATISCH ERKENNEN
    */

    const userColumns =
      await getUserTableColumns(
        env
      );

    const registrationColumn =
      findRegistrationColumn(
        userColumns
      );

    const registrationSelect =
      registrationColumn
        ? `
          users.${registrationColumn}
            AS registered_at
        `
        : `
          NULL AS registered_at
        `;


    /*
      FILTER
    */

    const conditions = [];
    const bindings = [];

    /*
      GELÖSCHTE ACCOUNTS AUSBLENDEN

      Gelöschte Accounts werden beim Löschen anonymisiert und
      bekommen einen Namen wie "Deleted User ...".

      Dieser Filter wirkt automatisch sowohl auf die eigentliche
      Benutzerliste als auch auf COUNT(*), weil beide Abfragen
      denselben whereClause verwenden.
    */
    conditions.push(`
      LOWER(TRIM(users.username))
        NOT LIKE 'deleted user%'
      AND LOWER(TRIM(users.username))
        NOT LIKE 'deleted_user%'
      AND LOWER(TRIM(users.username))
        NOT LIKE 'deleted-user%'
    `);

    if (search) {
      conditions.push(`
        LOWER(users.username)
        LIKE LOWER(?)
      `);

      bindings.push(
        `%${search}%`
      );
    }


    /*
      ADMIN FILTER
    */

    if (
      requestedServer ===
      "ADMIN"
    ) {
      conditions.push(`
        users.role = 'admin'
      `);
    }


    /*
      NORMALER SERVER-FILTER

      Unterstützt sowohl Kurzform
      als auch alte/lange Servernamen.
    */

    else if (
      requestedServer
    ) {
      conditions.push(`
        users.role != 'admin'
      `);

      const values =
        SERVER_FILTER_VALUES[
          requestedServer
        ] || [
          requestedServer
        ];

      const placeholders =
        values
          .map(() => "?")
          .join(", ");

      conditions.push(`
        users.server IN (
          ${placeholders}
        )
      `);

      bindings.push(
        ...values
      );
    }


    const whereClause =
      conditions.length
        ? `
          WHERE
            ${conditions.join(
              " AND "
            )}
        `
        : "";


    /*
      SORTIERUNG
    */

    const orderBy =
      getOrderBy(
        sort
      );


    /*
      COUNT
    */

    const countRow =
      await env.DB
        .prepare(`
          SELECT
            COUNT(*) AS total
          FROM users
          ${whereClause}
        `)
        .bind(
          ...bindings
        )
        .first();

    const total =
      Number(
        countRow?.total || 0
      );


    /*
      USERS + FORUM-BAN
    */

    const query = `
      SELECT
        users.id,
        users.username,
        users.server,
        users.role,

        ${registrationSelect},

        forum_bans.id
          AS forum_ban_id,

        forum_bans.reason
          AS forum_ban_reason,

        forum_bans.banned_at
          AS forum_ban_banned_at,

        forum_bans.expires_at
          AS forum_ban_expires_at

      FROM users

      LEFT JOIN forum_bans
        ON forum_bans.id = (
          SELECT
            fb.id
          FROM forum_bans fb
          WHERE
            fb.user_id =
              users.id
            AND fb.active = 1
            AND (
              fb.expires_at IS NULL
              OR fb.expires_at >
                 strftime(
                   '%s',
                   'now'
                 )
            )
          ORDER BY
            fb.banned_at DESC
          LIMIT 1
        )

      ${whereClause}

      ORDER BY
        ${orderBy}

      LIMIT ?
      OFFSET ?
    `;


    const result =
      await env.DB
        .prepare(
          query
        )
        .bind(
          ...bindings,
          limit,
          offset
        )
        .all();


    /*
      RESPONSE AUFBEREITEN
    */

    const users =
      (
        result.results || []
      )
        .map(user => {

          let forumBan = null;

          /*
            Admins sind gegen
            Forum-Banns geschützt.
          */

          if (
            user.role !==
              "admin" &&
            user.forum_ban_id
          ) {
            forumBan =
              serializeForumBan({
                id:
                  user.forum_ban_id,

                reason:
                  user.forum_ban_reason,

                banned_at:
                  user.forum_ban_banned_at,

                expires_at:
                  user.forum_ban_expires_at
              });
          }

          return {
            id:
              Number(
                user.id
              ),

            username:
              user.username,

            server:
              normalizeServer(
                user.server,
                user.role
              ),

            role:
              user.role,

            registered_at:
              user.registered_at ??
              null,

            forum_banned:
              Boolean(
                forumBan
              ),

            forum_ban:
              forumBan,

            protected:
              user.role ===
              "admin",

            actions: {
              can_forum_ban:
                user.role !==
                "admin",

              can_forum_unban:
                user.role !==
                  "admin" &&
                Boolean(
                  forumBan
                ),

              can_delete:
                user.role !==
                "admin"
            }
          };
        });


    /*
      RESPONSE
    */

    return json({
      ok: true,

      users,

      pagination: {
        total,
        limit,
        offset,

        returned:
          users.length,

        has_more:
          offset +
            users.length <
          total
      },

      filters: {
        q:
          search,

        server:
          requestedServer ||
          null,

        sort
      },

      registration_date_available:
        Boolean(
          registrationColumn
        )
    });

  } catch (error) {
    console.error(
      "Admin users GET error:",
      error
    );

    return json(
      {
        ok: false,
        error:
          "Internal server error."
      },
      500
    );
  }
}


/*
  ----------------------------------------------------
  POST NICHT ERLAUBT
  ----------------------------------------------------
*/

export async function onRequestPost() {
  return json(
    {
      ok: false,
      error:
        "Method not allowed."
    },
    405
  );
}


/*
  ----------------------------------------------------
  PUT NICHT ERLAUBT
  ----------------------------------------------------
*/

export async function onRequestPut() {
  return json(
    {
      ok: false,
      error:
        "Method not allowed."
    },
    405
  );
}


/*
  ----------------------------------------------------
  PATCH NICHT ERLAUBT
  ----------------------------------------------------
*/

export async function onRequestPatch() {
  return json(
    {
      ok: false,
      error:
        "Method not allowed."
    },
    405
  );
}


/*
  ----------------------------------------------------
  DELETE NICHT ERLAUBT

  Account-Löschung läuft bewusst
  separat über:

  /api/admin/delete-user
  ----------------------------------------------------
*/

export async function onRequestDelete() {
  return json(
    {
      ok: false,
      error:
        "Method not allowed."
    },
    405
  );
}

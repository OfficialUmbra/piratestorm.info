const CONFIRMATION_TEXT = "DELETE";

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
  const cookieHeader =
    request.headers.get("Cookie") || "";

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();

    if (!trimmed) continue;

    const separatorIndex =
      trimmed.indexOf("=");

    if (separatorIndex === -1) continue;

    const key =
      trimmed
        .slice(0, separatorIndex)
        .trim();

    const value =
      trimmed
        .slice(separatorIndex + 1)
        .trim();

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

function expiredSessionCookie() {
  return [
    "ps_session=",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0"
  ].join("; ");
}

async function getCurrentUser(request, env) {
  const sessionId =
    getCookie(
      request,
      "ps_session"
    );

  if (!sessionId) {
    return null;
  }

  const now =
    Math.floor(Date.now() / 1000);

  const user =
    await env.DB.prepare(`
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
        AND LOWER(TRIM(users.username))
          NOT LIKE 'deleteduser_%'
        AND LOWER(TRIM(users.username))
          NOT LIKE 'deleted user%'
        AND LOWER(TRIM(users.username))
          NOT LIKE 'deleted_user%'
        AND LOWER(TRIM(users.username))
          NOT LIKE 'deleted-user%'
      LIMIT 1
    `)
      .bind(
        sessionId,
        now
      )
      .first();

  return user || null;
}

async function tableExists(
  env,
  tableName
) {
  const row =
    await env.DB.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
      LIMIT 1
    `)
      .bind(tableName)
      .first();

  return Boolean(row);
}

async function getTableColumns(
  env,
  tableName
) {
  if (
    !(await tableExists(
      env,
      tableName
    ))
  ) {
    return [];
  }

  const result =
    await env.DB.prepare(
      `PRAGMA table_info(${tableName})`
    ).all();

  return Array.isArray(result.results)
    ? result.results.map(
        column => column.name
      )
    : [];
}

async function deleteWhereUserId(
  env,
  tableName,
  columnName,
  userId
) {
  if (
    !(await tableExists(
      env,
      tableName
    ))
  ) {
    return;
  }

  const columns =
    await getTableColumns(
      env,
      tableName
    );

  if (
    !columns.includes(columnName)
  ) {
    return;
  }

  await env.DB.prepare(`
    DELETE FROM ${tableName}
    WHERE ${columnName} = ?
  `)
    .bind(userId)
    .run();
}

async function deleteUserRelations(
  env,
  userId
) {
  /*
    Sessions:
    Der Account wird sofort überall ausgeloggt.
  */
  await deleteWhereUserId(
    env,
    "sessions",
    "user_id",
    userId
  );

  /*
    Presence:
    Der gelöschte Account soll weder im Chat
    noch in der allgemeinen Online-Anzeige
    erscheinen.
  */
  await deleteWhereUserId(
    env,
    "chat_presence",
    "user_id",
    userId
  );

  await deleteWhereUserId(
    env,
    "site_presence",
    "user_id",
    userId
  );

  /*
    Persönliche Chat-Einstellungen.
  */
  await deleteWhereUserId(
    env,
    "chat_user_settings",
    "user_id",
    userId
  );

  /*
    Persönliche Blocklisten.
  */
  await deleteWhereUserId(
    env,
    "chat_blocks",
    "blocker_id",
    userId
  );

  await deleteWhereUserId(
    env,
    "chat_blocks",
    "blocked_id",
    userId
  );

  /*
    Whisper-Lesestatus.
  */
  await deleteWhereUserId(
    env,
    "whisper_read_state",
    "user_id",
    userId
  );

  /*
    Offene Whisper-Einladungen:
    sowohl als eingeladener Nutzer als
    auch als Einladender.
  */
  await deleteWhereUserId(
    env,
    "whisper_invites",
    "invited_user_id",
    userId
  );

  await deleteWhereUserId(
    env,
    "whisper_invites",
    "inviter_id",
    userId
  );

  /*
    Whisper-Mitgliedschaften entfernen.

    Die Nachrichten selbst bleiben erhalten
    und erscheinen durch den anonymisierten
    users-Datensatz nicht mehr unter dem
    ursprünglichen Spielernamen.
  */
  await deleteWhereUserId(
    env,
    "whisper_members",
    "user_id",
    userId
  );

  /*
    Likes entfernen.
  */
  await deleteWhereUserId(
    env,
    "post_likes",
    "user_id",
    userId
  );

  await deleteWhereUserId(
    env,
    "comment_likes",
    "user_id",
    userId
  );

  /*
    Aktive Forum-Banns deaktivieren.
    Die Historie bleibt bestehen.
  */
  if (
    await tableExists(
      env,
      "forum_bans"
    )
  ) {
    await env.DB.prepare(`
      UPDATE forum_bans
      SET active = 0
      WHERE user_id = ?
        AND active = 1
    `)
      .bind(userId)
      .run();
  }

  /*
    Aktive Chat-Banns ebenfalls deaktivieren.
  */
  if (
    await tableExists(
      env,
      "chat_bans"
    )
  ) {
    await env.DB.prepare(`
      UPDATE chat_bans
      SET active = 0
      WHERE user_id = ?
        AND active = 1
    `)
      .bind(userId)
      .run();
  }

  /*
    ACHTUNG:
    Wir löschen bewusst NICHT automatisch:

    - chat_messages
    - whisper_messages
    - Forum-Beiträge
    - Reports
    - Moderationsprotokolle
    - Moderationsnotizen
    - Ban-/Kick-Historie

    Öffentliche Beiträge bleiben Teil
    bestehender Unterhaltungen, werden durch
    die Anonymisierung des users-Datensatzes
    aber nicht mehr unter dem bisherigen
    Spielernamen angezeigt.

    Moderations-/Reportdaten können außerdem
    für Missbrauchsschutz, Nachvollziehbarkeit
    oder Rechtsansprüche relevant sein.
  */
}

async function anonymizeUser(
  env,
  user
) {
  const anonymousUsername =
    `DeletedUser_${user.id}`;

  const columns =
    await getTableColumns(
      env,
      "users"
    );

  const assignments = [
    "username = ?"
  ];

  const bindings = [
    anonymousUsername
  ];

  /*
    Schema der users-Tabelle laden.
  */
  const serverInfo =
    await env.DB.prepare(`
      PRAGMA table_info(users)
    `).all();

  /*
    Serverzuordnung entfernen,
    sofern NULL erlaubt ist.
  */
  const serverColumn =
    (serverInfo.results || []).find(
      column =>
        column.name === "server"
    );

  if (
    serverColumn &&
    Number(serverColumn.notnull) === 0
  ) {
    assignments.push(
      "server = NULL"
    );
  }

  /*
    Bekannte personenbezogene Felder.
  */
  const nullableSensitiveFields = [
    "email",
    "display_name",
    "real_name",
    "avatar",
    "avatar_url",
    "bio"
  ];

  for (
    const field
    of nullableSensitiveFields
  ) {
    if (
      !columns.includes(field)
    ) {
      continue;
    }

    const info =
      (serverInfo.results || []).find(
        column =>
          column.name === field
      );

    if (
      !info ||
      Number(info.notnull) === 0
    ) {
      assignments.push(
        `${field} = NULL`
      );
    }
  }

  /*
    Löschzeitpunkt setzen,
    falls deleted_at existiert.
  */
  if (
    columns.includes("deleted_at")
  ) {
    assignments.push(
      "deleted_at = strftime('%s','now')"
    );
  }

  /*
    Account deaktivieren,
    falls entsprechende Felder existieren.
  */
  if (
    columns.includes("active")
  ) {
    assignments.push(
      "active = 0"
    );
  }

  if (
    columns.includes("is_active")
  ) {
    assignments.push(
      "is_active = 0"
    );
  }

  /*
    Passwortdaten unbrauchbar machen.
  */
  const passwordFields = [
    "password",
    "password_hash"
  ];

  for (
    const field
    of passwordFields
  ) {
    if (
      !columns.includes(field)
    ) {
      continue;
    }

    const info =
      (serverInfo.results || []).find(
        column =>
          column.name === field
      );

    if (
      !info ||
      Number(info.notnull) === 0
    ) {
      assignments.push(
        `${field} = NULL`
      );
    } else {
      const randomReplacement =
        `deleted_${crypto.randomUUID()}_${crypto.randomUUID()}`;

      assignments.push(
        `${field} = ?`
      );

      bindings.push(
        randomReplacement
      );
    }
  }

  /*
    Falls E-Mail NOT NULL ist,
    durch nicht zustellbare Adresse ersetzen.
  */
  if (
    columns.includes("email")
  ) {
    const emailInfo =
      (serverInfo.results || []).find(
        column =>
          column.name === "email"
      );

    if (
      emailInfo &&
      Number(emailInfo.notnull) === 1
    ) {
      assignments.push(
        "email = ?"
      );

      bindings.push(
        `deleted-${user.id}-${crypto.randomUUID()}@invalid.invalid`
      );
    }
  }

  bindings.push(
    user.id
  );

  await env.DB.prepare(`
    UPDATE users
    SET ${assignments.join(", ")}
    WHERE id = ?
  `)
    .bind(...bindings)
    .run();

  return anonymousUsername;
}


/*
  GET /api/account/delete

  Liefert Informationen zur Accountlöschung
  für den aktuell eingeloggten Nutzer.
*/

export async function onRequestGet(
  context
) {
  const {
    request,
    env
  } = context;

  try {
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

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json(
        {
          ok: false,
          error:
            "Not logged in."
        },
        401
      );
    }

    return json({
      ok: true,

      account: {
        id:
          user.id,

        username:
          user.username,

        server:
          user.role === "admin"
            ? "ADMIN"
            : user.server,

        role:
          user.role
      },

      deletion: {
        available:
          user.role !== "admin",

        confirmation_text:
          CONFIRMATION_TEXT,

        effects: [
          "The account will be permanently disabled.",
          "All active sessions will be terminated.",
          "The public username will be anonymized.",
          "The server assignment will be removed where possible.",
          "Personal chat settings and presence data will be removed.",
          "Existing forum or chat contributions may remain in anonymized form.",
          "Moderation or report data may be retained where necessary."
        ]
      }
    });

  } catch (error) {
    console.error(
      "Account delete GET error:",
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
  DELETE /api/account/delete

  JSON:

  {
    "confirmation": "DELETE"
  }

  Optional:

  {
    "confirmation": "DELETE",
    "username": "Spielername"
  }

  Der Endpoint kann ausschließlich den
  aktuell eingeloggten eigenen Account löschen.
*/

export async function onRequestDelete(
  context
) {
  const {
    request,
    env
  } = context;

  try {
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

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json(
        {
          ok: false,
          error:
            "Not logged in."
        },
        401
      );
    }

    /*
      Admin-Accounts dürfen nicht über die
      normale Accountlöschung gelöscht werden.
    */
    if (
      user.role === "admin"
    ) {
      return json(
        {
          ok: false,
          error:
            "The administrator account cannot be deleted through this endpoint."
        },
        403
      );
    }

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          ok: false,
          error:
            "Invalid JSON body."
        },
        400
      );
    }

    const confirmation =
      typeof body?.confirmation === "string"
        ? body.confirmation.trim()
        : "";

    if (
      confirmation !== CONFIRMATION_TEXT
    ) {
      return json(
        {
          ok: false,
          error:
            `Please confirm account deletion with "${CONFIRMATION_TEXT}".`
        },
        400
      );
    }

    /*
      Optional kann das Frontend zusätzlich
      den aktuellen Spielernamen mitsenden.
    */
    if (
      body?.username !== undefined &&
      String(body.username).trim() !==
        user.username
    ) {
      return json(
        {
          ok: false,
          error:
            "Username confirmation does not match."
        },
        400
      );
    }

    /*
      Zuerst Account anonymisieren.

      Dadurch bleiben Beiträge/Nachrichten
      strukturell erhalten, zeigen aber nicht
      mehr den ursprünglichen Spielernamen.
    */
    const anonymousUsername =
      await anonymizeUser(
        env,
        user
      );

    /*
      Danach alle persönlichen bzw.
      verzichtbaren Verknüpfungen entfernen.
      Sämtliche Sessions werden ebenfalls
      gelöscht.
    */
    await deleteUserRelations(
      env,
      user.id
    );

    return new Response(
      JSON.stringify({
        ok: true,

        deleted: true,

        message:
          "Account deleted successfully.",

        anonymous_username:
          anonymousUsername
      }),
      {
        status: 200,

        headers: {
          "Content-Type":
            "application/json; charset=utf-8",

          "Cache-Control":
            "no-store",

          /*
            Browser-Session sofort entfernen.
          */
          "Set-Cookie":
            expiredSessionCookie()
        }
      }
    );

  } catch (error) {
    console.error(
      "Account delete DELETE error:",
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
  Alle anderen Methoden gesperrt.
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

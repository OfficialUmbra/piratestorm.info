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

async function getTableInfo(
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

  return result.results || [];
}

async function deleteRelation(
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
    await getTableInfo(
      env,
      tableName
    );

  if (
    !columns.some(
      column =>
        column.name === columnName
    )
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

async function cleanUserRelations(
  env,
  userId
) {
  /*
    Login-Sessions entfernen.
  */
  await deleteRelation(
    env,
    "sessions",
    "user_id",
    userId
  );

  /*
    Presence.
  */
  await deleteRelation(
    env,
    "chat_presence",
    "user_id",
    userId
  );

  await deleteRelation(
    env,
    "site_presence",
    "user_id",
    userId
  );

  /*
    Persönliche Chat-Einstellungen.
  */
  await deleteRelation(
    env,
    "chat_user_settings",
    "user_id",
    userId
  );

  /*
    Blocklisten.
  */
  await deleteRelation(
    env,
    "chat_blocks",
    "blocker_id",
    userId
  );

  await deleteRelation(
    env,
    "chat_blocks",
    "blocked_id",
    userId
  );

  /*
    Whisper-Lesestatus.
  */
  await deleteRelation(
    env,
    "whisper_read_state",
    "user_id",
    userId
  );

  /*
    Offene Whisper-Einladungen:
    sowohl als eingeladener Nutzer als
    auch als Einladender entfernen.
  */
  await deleteRelation(
    env,
    "whisper_invites",
    "invited_user_id",
    userId
  );

  await deleteRelation(
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
  await deleteRelation(
    env,
    "whisper_members",
    "user_id",
    userId
  );

  /*
    Likes entfernen.

    Likes sind keine notwendigen Bestandteile
    bestehender Unterhaltungen.
  */
  await deleteRelation(
    env,
    "post_likes",
    "user_id",
    userId
  );

  await deleteRelation(
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
    Chat-Banns ebenfalls deaktivieren.
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
    NICHT automatisch löschen:

    - posts
    - comments
    - chat_messages
    - whisper_messages
    - reports
    - Moderationslogs
    - Moderationsnotizen
    - Ban-/Kick-Historie

    Dadurch bleiben bestehende Diskussionen
    und notwendige Moderationshistorien
    strukturell erhalten.
  */
}

async function anonymizeUser(
  env,
  user
) {
  const anonymousUsername =
    `DeletedUser_${user.id}`;

  const tableInfo =
    await getTableInfo(
      env,
      "users"
    );

  const columns =
    tableInfo.map(
      column => column.name
    );

  const assignments = [
    "username = ?"
  ];

  const bindings = [
    anonymousUsername
  ];

  /*
    Server entfernen, wenn NULL erlaubt ist.
  */
  const serverColumn =
    tableInfo.find(
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
  const sensitiveFields = [
    "email",
    "display_name",
    "real_name",
    "avatar",
    "avatar_url",
    "bio"
  ];

  for (
    const field
    of sensitiveFields
  ) {
    if (
      !columns.includes(field)
    ) {
      continue;
    }

    const info =
      tableInfo.find(
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
    E-Mail kann NOT NULL sein.
  */
  if (
    columns.includes("email")
  ) {
    const info =
      tableInfo.find(
        column =>
          column.name === "email"
      );

    if (
      info &&
      Number(info.notnull) === 1
    ) {
      assignments.push(
        "email = ?"
      );

      bindings.push(
        `deleted-${user.id}-${crypto.randomUUID()}@invalid.invalid`
      );
    }
  }

  /*
    Passwort unbrauchbar machen.
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
      tableInfo.find(
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
      assignments.push(
        `${field} = ?`
      );

      bindings.push(
        `deleted_${crypto.randomUUID()}_${crypto.randomUUID()}`
      );
    }
  }

  /*
    Optional vorhandene Statusfelder.
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

  if (
    columns.includes("deleted_at")
  ) {
    assignments.push(
      "deleted_at = strftime('%s','now')"
    );
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

async function writeModerationLog(
  env,
  admin,
  target,
  anonymousUsername
) {
  if (
    !(await tableExists(
      env,
      "chat_moderation_log"
    ))
  ) {
    return;
  }

  try {
    await env.DB.prepare(`
      INSERT INTO chat_moderation_log (
        admin_id,
        target_user_id,
        action,
        details,
        created_at
      )
      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(
        admin.id,
        target.id,
        "admin_account_delete",
        JSON.stringify({
          previous_username:
            target.username,

          anonymous_username:
            anonymousUsername
        }),
        Math.floor(
          Date.now() / 1000
        )
      )
      .run();
  } catch (error) {
    /*
      Accountlöschung soll nicht scheitern,
      nur weil das Moderationslog einmal
      nicht geschrieben werden kann.
    */
    console.error(
      "Admin delete moderation log error:",
      error
    );
  }
}


/*
  DELETE /api/admin/delete-user

  JSON:

  {
    "user_id": 123,
    "confirmation": "DELETE"
  }
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

    const admin =
      await getCurrentUser(
        request,
        env
      );

    if (!admin) {
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
      admin.role !== "admin"
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

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          ok: false,
          error:
            "Invalid JSON."
        },
        400
      );
    }

    const userId =
      Number(
        body?.user_id
      );

    const confirmation =
      String(
        body?.confirmation || ""
      ).trim();

    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      return json(
        {
          ok: false,
          error:
            "Invalid user_id."
        },
        400
      );
    }

    if (
      confirmation !== "DELETE"
    ) {
      return json(
        {
          ok: false,
          error:
            'Please confirm with "DELETE".'
        },
        400
      );
    }

    const target =
      await env.DB.prepare(`
        SELECT
          id,
          username,
          server,
          role
        FROM users
        WHERE id = ?
        LIMIT 1
      `)
        .bind(userId)
        .first();

    if (!target) {
      return json(
        {
          ok: false,
          error:
            "User not found."
        },
        404
      );
    }

    /*
      Kein Admin darf sich selbst löschen.
    */
    if (
      Number(target.id) ===
      Number(admin.id)
    ) {
      return json(
        {
          ok: false,
          error:
            "You cannot delete your own administrator account."
        },
        403
      );
    }

    /*
      Andere Administratoren sind ebenfalls
      geschützt.

      Selbst wenn später ein zweiter Admin
      angelegt wird, kann dieser Endpoint
      keinen Admin-Account entfernen.
    */
    if (
      target.role === "admin"
    ) {
      return json(
        {
          ok: false,
          error:
            "Administrator accounts are protected."
        },
        403
      );
    }

    /*
      Bereits anonymisierte Accounts nicht
      noch einmal bearbeiten.
    */
    if (
      String(
        target.username || ""
      ).startsWith(
        "DeletedUser_"
      )
    ) {
      return json(
        {
          ok: false,
          error:
            "This account has already been deleted."
        },
        409
      );
    }

    /*
      Zuerst anonymisieren.

      Dadurch zeigen bestehende Posts,
      Kommentare und Nachrichten anschließend
      nicht mehr den alten Spielernamen.
    */
    const anonymousUsername =
      await anonymizeUser(
        env,
        target
      );

    /*
      Danach verzichtbare Verknüpfungen
      und alle Sessions entfernen.
    */
    await cleanUserRelations(
      env,
      target.id
    );

    /*
      Admin-Aktion protokollieren.
    */
    await writeModerationLog(
      env,
      admin,
      target,
      anonymousUsername
    );

    return json({
      ok: true,

      deleted: true,

      user_id:
        Number(target.id),

      previous_username:
        target.username,

      anonymous_username:
        anonymousUsername,

      message:
        `${target.username} was deleted and anonymized.`
    });

  } catch (error) {
    console.error(
      "Admin delete user error:",
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

export async function onRequestGet() {
  return json(
    {
      ok: false,
      error:
        "Method not allowed."
    },
    405
  );
}

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

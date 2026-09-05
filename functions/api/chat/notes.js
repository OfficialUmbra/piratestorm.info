const MAX_NOTE_LENGTH = 2000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;


/*
 * =====================================================
 * RESPONSE
 * =====================================================
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
 * =====================================================
 * COOKIE
 * =====================================================
 */

function getCookie(
  request,
  name
) {
  const cookie =
    request.headers.get(
      "Cookie"
    ) || "";

  for (
    const part
    of cookie.split(";")
  ) {
    const [
      key,
      ...value
    ] =
      part
        .trim()
        .split("=");

    if (
      key === name
    ) {
      return decodeURIComponent(
        value.join("=")
      );
    }
  }

  return null;
}


/*
 * =====================================================
 * CURRENT USER
 * =====================================================
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

  return await env.DB.prepare(`
    SELECT
      u.id,
      u.username,
      u.server,
      u.role

    FROM sessions s

    JOIN users u
      ON u.id = s.user_id

    WHERE s.id = ?
      AND s.expires_at > ?

    LIMIT 1
  `)
    .bind(
      sessionId,
      now
    )
    .first();
}


/*
 * =====================================================
 * ROLE HELPERS
 * =====================================================
 */

function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
}


function isModerator(user) {
  return Boolean(
    user &&
    user.role === "moderator"
  );
}


function canModerate(user) {
  return Boolean(
    user &&
    (
      isAdmin(user) ||
      isModerator(user)
    )
  );
}


/*
 * =====================================================
 * GENERIC HELPERS
 * =====================================================
 */

function cleanText(value) {
  if (
    typeof value !==
    "string"
  ) {
    return "";
  }

  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}


function toPositiveInt(value) {
  const number =
    Number(value);

  if (
    !Number.isInteger(number) ||
    number <= 0
  ) {
    return null;
  }

  return number;
}


/*
 * =====================================================
 * MODERATOR AUTH
 * =====================================================
 */

async function requireModerator(
  request,
  env
) {
  const user =
    await getCurrentUser(
      request,
      env
    );

  if (!user) {
    return {
      ok:
        false,

      response:
        json({
          ok:
            false,

          error:
            "Du musst eingeloggt sein."
        }, 401)
    };
  }

  if (
    !canModerate(user)
  ) {
    return {
      ok:
        false,

      response:
        json({
          ok:
            false,

          error:
            "Nur Administratoren und Moderatoren dürfen Moderationsnotizen verwenden."
        }, 403)
    };
  }

  return {
    ok:
      true,

    user
  };
}


/*
 * =====================================================
 * USER LOOKUP
 * =====================================================
 */

async function getUserById(
  env,
  userId
) {
  return await env.DB.prepare(`
    SELECT
      id,
      username,
      server,
      role

    FROM users

    WHERE id = ?

    LIMIT 1
  `)
    .bind(
      userId
    )
    .first();
}


/*
 * =====================================================
 * TARGET PERMISSION
 * =====================================================
 *
 * ADMIN
 * -> darf User + Moderator verwalten
 *
 * MODERATOR
 * -> darf ausschließlich User verwalten
 *
 * ADMIN TARGET
 * -> niemals
 * =====================================================
 */

function canModerateTarget(
  actor,
  target
) {
  if (
    !actor ||
    !target
  ) {
    return false;
  }

  if (
    Number(actor.id) ===
    Number(target.id)
  ) {
    return false;
  }

  if (
    target.role ===
    "admin"
  ) {
    return false;
  }

  if (
    isModerator(actor)
  ) {
    return (
      target.role ===
      "user"
    );
  }

  if (
    isAdmin(actor)
  ) {
    return (
      target.role ===
        "user" ||
      target.role ===
        "moderator"
    );
  }

  return false;
}


/*
 * =====================================================
 * TARGET ERROR
 * =====================================================
 */

function targetPermissionError(
  actor,
  target
) {
  if (
    !target
  ) {
    return "Spieler wurde nicht gefunden.";
  }

  if (
    Number(actor?.id) ===
    Number(target.id)
  ) {
    return "Du kannst keine Moderationsnotiz über dich selbst führen.";
  }

  if (
    target.role ===
    "admin"
  ) {
    return "Für Administratoren können keine Moderationsnotizen geführt werden.";
  }

  if (
    isModerator(actor) &&
    target.role ===
    "moderator"
  ) {
    return "Moderatoren dürfen keine Moderationsnotizen zu anderen Moderatoren verwalten.";
  }

  return "Du darfst diesen Spieler nicht moderieren.";
}


/*
 * =====================================================
 * NOTE LOOKUP
 * =====================================================
 */

async function getNoteById(
  env,
  noteId
) {
  return await env.DB.prepare(`
    SELECT
      n.id,
      n.admin_id,
      n.target_user_id,
      n.note,
      n.created_at,
      n.updated_at,

      actor.username
        AS admin_username,

      actor.server
        AS admin_server,

      actor.role
        AS admin_role,

      target.username
        AS target_username,

      target.server
        AS target_server,

      target.role
        AS target_role

    FROM chat_moderation_notes n

    JOIN users actor
      ON actor.id =
        n.admin_id

    JOIN users target
      ON target.id =
        n.target_user_id

    WHERE n.id = ?

    LIMIT 1
  `)
    .bind(
      noteId
    )
    .first();
}


/*
 * =====================================================
 * FORMAT NOTE
 * =====================================================
 */

function formatNote(row) {
  if (!row) {
    return null;
  }

  return {
    id:
      row.id,

    note:
      row.note,

    created_at:
      row.created_at,

    updated_at:
      row.updated_at,

    admin: {
      id:
        row.admin_id,

      username:
        row.admin_username,

      server:
        row.admin_server,

      role:
        row.admin_role,

      is_admin:
        row.admin_role ===
        "admin",

      is_moderator:
        row.admin_role ===
        "moderator"
    },

    target_user: {
      id:
        row.target_user_id,

      username:
        row.target_username,

      server:
        row.target_server,

      role:
        row.target_role,

      is_admin:
        row.target_role ===
        "admin",

      is_moderator:
        row.target_role ===
        "moderator"
    }
  };
}


/*
 * =====================================================
 * MODERATION LOG
 * =====================================================
 */

async function addModerationLog(
  env,
  actorId,
  targetUserId,
  action,
  details
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

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
        actorId,
        targetUserId ||
        null,
        action,
        JSON.stringify(
          details || {}
        ),
        now
      )
      .run();

  } catch (error) {
    console.error(
      "Moderation note log error:",
      error
    );
  }
}


/*
 * =====================================================
 * GET
 * =====================================================
 *
 * GET /api/chat/notes
 *
 * GET /api/chat/notes?user_id=123
 *
 * GET /api/chat/notes?id=456
 * =====================================================
 */

export async function onRequestGet(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    const auth =
      await requireModerator(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return auth.response;
    }

    const actor =
      auth.user;

    const url =
      new URL(
        request.url
      );

    const noteId =
      toPositiveInt(
        url.searchParams.get(
          "id"
        )
      );

    const targetUserId =
      toPositiveInt(
        url.searchParams.get(
          "user_id"
        )
      );

    let rawLimit =
      Number(
        url.searchParams.get(
          "limit"
        ) ||
        DEFAULT_LIMIT
      );

    if (
      !Number.isInteger(
        rawLimit
      )
    ) {
      rawLimit =
        DEFAULT_LIMIT;
    }

    const limit =
      Math.max(
        1,
        Math.min(
          rawLimit,
          MAX_LIMIT
        )
      );


    /*
     * =================================================
     * SINGLE NOTE
     * =================================================
     */

    if (
      noteId
    ) {
      const note =
        await getNoteById(
          env,
          noteId
        );

      if (!note) {
        return json({
          ok:
            false,

          error:
            "Moderationsnotiz wurde nicht gefunden."
        }, 404);
      }

      const target = {
        id:
          note.target_user_id,

        username:
          note.target_username,

        server:
          note.target_server,

        role:
          note.target_role
      };

      if (
        !canModerateTarget(
          actor,
          target
        )
      ) {
        return json({
          ok:
            false,

          error:
            targetPermissionError(
              actor,
              target
            )
        }, 403);
      }

      return json({
        ok:
          true,

        note:
          formatNote(
            note
          )
      });
    }


    /*
     * =================================================
     * NOTES FOR ONE USER
     * =================================================
     */

    if (
      targetUserId
    ) {
      const target =
        await getUserById(
          env,
          targetUserId
        );

      if (!target) {
        return json({
          ok:
            false,

          error:
            "Spieler wurde nicht gefunden."
        }, 404);
      }

      if (
        !canModerateTarget(
          actor,
          target
        )
      ) {
        return json({
          ok:
            false,

          error:
            targetPermissionError(
              actor,
              target
            )
        }, 403);
      }

      const result =
        await env.DB.prepare(`
          SELECT
            n.id,
            n.admin_id,
            n.target_user_id,
            n.note,
            n.created_at,
            n.updated_at,

            note_actor.username
              AS admin_username,

            note_actor.server
              AS admin_server,

            note_actor.role
              AS admin_role,

            target.username
              AS target_username,

            target.server
              AS target_server,

            target.role
              AS target_role

          FROM chat_moderation_notes n

          JOIN users note_actor
            ON note_actor.id =
              n.admin_id

          JOIN users target
            ON target.id =
              n.target_user_id

          WHERE n.target_user_id = ?

          ORDER BY
            n.created_at DESC,
            n.id DESC

          LIMIT ?
        `)
          .bind(
            targetUserId,
            limit
          )
          .all();

      const notes =
        (
          result.results ||
          []
        ).map(
          formatNote
        );

      return json({
        ok:
          true,

        target_user: {
          id:
            target.id,

          username:
            target.username,

          server:
            target.server,

          role:
            target.role,

          is_admin:
            target.role ===
            "admin",

          is_moderator:
            target.role ===
            "moderator"
        },

        count:
          notes.length,

        notes
      });
    }


    /*
     * =================================================
     * ALL NOTES
     * =================================================
     */

    let query = `
      SELECT
        n.id,
        n.admin_id,
        n.target_user_id,
        n.note,
        n.created_at,
        n.updated_at,

        note_actor.username
          AS admin_username,

        note_actor.server
          AS admin_server,

        note_actor.role
          AS admin_role,

        target.username
          AS target_username,

        target.server
          AS target_server,

        target.role
          AS target_role

      FROM chat_moderation_notes n

      JOIN users note_actor
        ON note_actor.id =
          n.admin_id

      JOIN users target
        ON target.id =
          n.target_user_id

      WHERE
    `;

    /*
     * Moderator sieht nur normale User.
     *
     * Admin sieht normale User + Moderatoren.
     */
    if (
      isModerator(
        actor
      )
    ) {
      query += `
        target.role = 'user'
      `;

    } else {
      query += `
        target.role != 'admin'
      `;
    }

    query += `
      ORDER BY
        n.created_at DESC,
        n.id DESC

      LIMIT ?
    `;

    const result =
      await env.DB
        .prepare(
          query
        )
        .bind(
          limit
        )
        .all();

    const notes =
      (
        result.results ||
        []
      ).map(
        formatNote
      );

    return json({
      ok:
        true,

      count:
        notes.length,

      notes
    });

  } catch (error) {
    console.error(
      "GET /api/chat/notes error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Moderationsnotizen konnten nicht geladen werden."
    }, 500);
  }
}


/*
 * =====================================================
 * POST
 * =====================================================
 *
 * {
 *   "user_id": 123,
 *   "note": "Mehrfach wegen Beleidigungen aufgefallen."
 * }
 * =====================================================
 */

export async function onRequestPost(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    const auth =
      await requireModerator(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return auth.response;
    }

    const actor =
      auth.user;

    let body;

    try {
      body =
        await request.json();

    } catch {
      return json({
        ok:
          false,

        error:
          "Ungültige Anfrage."
      }, 400);
    }

    const targetUserId =
      toPositiveInt(
        body.user_id ||
        body.target_user_id
      );

    const noteText =
      cleanText(
        body.note
      );

    if (
      !targetUserId
    ) {
      return json({
        ok:
          false,

        error:
          "Ungültiger Spieler."
      }, 400);
    }

    if (
      !noteText
    ) {
      return json({
        ok:
          false,

        error:
          "Die Moderationsnotiz darf nicht leer sein."
      }, 400);
    }

    if (
      noteText.length >
      MAX_NOTE_LENGTH
    ) {
      return json({
        ok:
          false,

        error:
          `Die Moderationsnotiz darf maximal ${MAX_NOTE_LENGTH} Zeichen enthalten.`
      }, 400);
    }

    const target =
      await getUserById(
        env,
        targetUserId
      );

    if (!target) {
      return json({
        ok:
          false,

        error:
          "Spieler wurde nicht gefunden."
      }, 404);
    }

    if (
      !canModerateTarget(
        actor,
        target
      )
    ) {
      return json({
        ok:
          false,

        error:
          targetPermissionError(
            actor,
            target
          )
      }, 403);
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    const insert =
      await env.DB.prepare(`
        INSERT INTO chat_moderation_notes (
          admin_id,
          target_user_id,
          note,
          created_at,
          updated_at
        )

        VALUES (?, ?, ?, ?, ?)
      `)
        .bind(
          actor.id,
          target.id,
          noteText,
          now,
          now
        )
        .run();

    const noteId =
      insert?.meta
        ?.last_row_id ||
      null;

    await addModerationLog(
      env,
      actor.id,
      target.id,
      "create_moderation_note",
      {
        note_id:
          noteId,

        actor_role:
          actor.role,

        username:
          target.username,

        server:
          target.server
      }
    );

    const created =
      noteId
        ? await getNoteById(
            env,
            noteId
          )
        : null;

    return json({
      ok:
        true,

      note:
        created
          ? formatNote(
              created
            )
          : {
              id:
                noteId,

              note:
                noteText,

              created_at:
                now,

              updated_at:
                now
            },

      message:
        "Moderationsnotiz wurde gespeichert."
    }, 201);

  } catch (error) {
    console.error(
      "POST /api/chat/notes error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Moderationsnotiz konnte nicht erstellt werden."
    }, 500);
  }
}


/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * {
 *   "id": 12,
 *   "note": "Neue Notiz..."
 * }
 * =====================================================
 */

export async function onRequestPut(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    const auth =
      await requireModerator(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return auth.response;
    }

    const actor =
      auth.user;

    let body;

    try {
      body =
        await request.json();

    } catch {
      return json({
        ok:
          false,

        error:
          "Ungültige Anfrage."
      }, 400);
    }

    const noteId =
      toPositiveInt(
        body.id ||
        body.note_id
      );

    const noteText =
      cleanText(
        body.note
      );

    if (
      !noteId
    ) {
      return json({
        ok:
          false,

        error:
          "Ungültige Moderationsnotiz."
      }, 400);
    }

    if (
      !noteText
    ) {
      return json({
        ok:
          false,

        error:
          "Die Moderationsnotiz darf nicht leer sein."
      }, 400);
    }

    if (
      noteText.length >
      MAX_NOTE_LENGTH
    ) {
      return json({
        ok:
          false,

        error:
          `Die Moderationsnotiz darf maximal ${MAX_NOTE_LENGTH} Zeichen enthalten.`
      }, 400);
    }

    const existing =
      await getNoteById(
        env,
        noteId
      );

    if (!existing) {
      return json({
        ok:
          false,

        error:
          "Moderationsnotiz wurde nicht gefunden."
      }, 404);
    }

    const target = {
      id:
        existing.target_user_id,

      username:
        existing.target_username,

      server:
        existing.target_server,

      role:
        existing.target_role
    };

    if (
      !canModerateTarget(
        actor,
        target
      )
    ) {
      return json({
        ok:
          false,

        error:
          targetPermissionError(
            actor,
            target
          )
      }, 403);
    }

    const oldText =
      existing.note;

    const now =
      Math.floor(
        Date.now() / 1000
      );

    await env.DB.prepare(`
      UPDATE chat_moderation_notes

      SET
        note = ?,
        updated_at = ?

      WHERE id = ?
    `)
      .bind(
        noteText,
        now,
        noteId
      )
      .run();

    await addModerationLog(
      env,
      actor.id,
      existing.target_user_id,
      "edit_moderation_note",
      {
        note_id:
          noteId,

        actor_role:
          actor.role,

        old_note:
          oldText,

        new_note:
          noteText
      }
    );

    const updated =
      await getNoteById(
        env,
        noteId
      );

    return json({
      ok:
        true,

      note:
        formatNote(
          updated
        ),

      message:
        "Moderationsnotiz wurde aktualisiert."
    });

  } catch (error) {
    console.error(
      "PUT /api/chat/notes error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Moderationsnotiz konnte nicht bearbeitet werden."
    }, 500);
  }
}


/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * DELETE /api/chat/notes?id=12
 * =====================================================
 */

export async function onRequestDelete(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    const auth =
      await requireModerator(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return auth.response;
    }

    const actor =
      auth.user;

    const url =
      new URL(
        request.url
      );

    const noteId =
      toPositiveInt(
        url.searchParams.get(
          "id"
        )
      );

    if (
      !noteId
    ) {
      return json({
        ok:
          false,

        error:
          "Ungültige Moderationsnotiz."
      }, 400);
    }

    const existing =
      await getNoteById(
        env,
        noteId
      );

    if (!existing) {
      return json({
        ok:
          false,

        error:
          "Moderationsnotiz wurde nicht gefunden."
      }, 404);
    }

    const target = {
      id:
        existing.target_user_id,

      username:
        existing.target_username,

      server:
        existing.target_server,

      role:
        existing.target_role
    };

    if (
      !canModerateTarget(
        actor,
        target
      )
    ) {
      return json({
        ok:
          false,

        error:
          targetPermissionError(
            actor,
            target
          )
      }, 403);
    }

    await env.DB.prepare(`
      DELETE FROM chat_moderation_notes

      WHERE id = ?
    `)
      .bind(
        noteId
      )
      .run();

    await addModerationLog(
      env,
      actor.id,
      existing.target_user_id,
      "delete_moderation_note",
      {
        note_id:
          noteId,

        actor_role:
          actor.role,

        deleted_note:
          existing.note,

        username:
          existing.target_username,

        server:
          existing.target_server
      }
    );

    return json({
      ok:
        true,

      deleted:
        true,

      note_id:
        noteId,

      message:
        "Moderationsnotiz wurde gelöscht."
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/notes error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Moderationsnotiz konnte nicht gelöscht werden."
    }, 500);
  }
}

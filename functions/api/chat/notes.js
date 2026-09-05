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
 * HELPERS
 * =====================================================
 */

function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
}


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
 * ADMIN AUTH
 * =====================================================
 */

async function requireAdmin(
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
    !isAdmin(user)
  ) {
    return {
      ok:
        false,

      response:
        json({
          ok:
            false,

          error:
            "Nur Administratoren dürfen Moderationsnotizen verwenden."
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

      admin.username
        AS admin_username,

      admin.server
        AS admin_server,

      admin.role
        AS admin_role,

      target.username
        AS target_username,

      target.server
        AS target_server,

      target.role
        AS target_role

    FROM chat_moderation_notes n

    JOIN users admin
      ON admin.id =
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
        row.admin_role
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
        "admin"
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
  adminId,
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
        adminId,
        targetUserId || null,
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
 * Nur Admin.
 *
 * Alle Notizen:
 *
 * GET /api/chat/notes
 *
 *
 * Notizen zu einem bestimmten Spieler:
 *
 * GET /api/chat/notes?user_id=123
 *
 *
 * Einzelne Notiz:
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
      await requireAdmin(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return auth.response;
    }

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

    if (noteId) {
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

    if (targetUserId) {
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

      /*
       * Admin-Immunität:
       *
       * Auch interne Moderationsnotizen sollen nicht
       * gegen den Administrator geführt werden.
       */
      if (
        target.role ===
        "admin"
      ) {
        return json({
          ok:
            false,

          error:
            "Für Administratoren können keine Moderationsnotizen geführt werden."
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

            admin.username
              AS admin_username,

            admin.server
              AS admin_server,

            admin.role
              AS admin_role,

            target.username
              AS target_username,

            target.server
              AS target_server,

            target.role
              AS target_role

          FROM chat_moderation_notes n

          JOIN users admin
            ON admin.id =
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
            target.role
        },

        count:
          (
            result.results ||
            []
          ).length,

        notes:
          (
            result.results ||
            []
          ).map(
            formatNote
          )
      });
    }


    /*
     * =================================================
     * ALL NOTES
     * =================================================
     */

    const result =
      await env.DB.prepare(`
        SELECT
          n.id,
          n.admin_id,
          n.target_user_id,
          n.note,
          n.created_at,
          n.updated_at,

          admin.username
            AS admin_username,

          admin.server
            AS admin_server,

          admin.role
            AS admin_role,

          target.username
            AS target_username,

          target.server
            AS target_server,

          target.role
            AS target_role

        FROM chat_moderation_notes n

        JOIN users admin
          ON admin.id =
            n.admin_id

        JOIN users target
          ON target.id =
            n.target_user_id

        WHERE target.role !=
          'admin'

        ORDER BY
          n.created_at DESC,
          n.id DESC

        LIMIT ?
      `)
        .bind(
          limit
        )
        .all();

    return json({
      ok:
        true,

      count:
        (
          result.results ||
          []
        ).length,

      notes:
        (
          result.results ||
          []
        ).map(
          formatNote
        )
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
 * Neue Notiz:
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
      await requireAdmin(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return auth.response;
    }

    const admin =
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

    /*
     * =================================================
     * ADMIN IMMUNITY
     * =================================================
     */

    if (
      target.role ===
      "admin"
    ) {
      return json({
        ok:
          false,

        error:
          "Für Administratoren können keine Moderationsnotizen erstellt werden."
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
          admin.id,
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
      admin.id,
      target.id,
      "create_moderation_note",
      {
        note_id:
          noteId
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
            }
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
 * Notiz bearbeiten:
 *
 * {
 *   "id": 12,
 *   "note": "Neue Notiz..."
 * }
 *
 * Nur der Admin kann sie bearbeiten.
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
      await requireAdmin(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return auth.response;
    }

    const admin =
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

    if (!noteId) {
      return json({
        ok:
          false,

        error:
          "Ungültige Moderationsnotiz."
      }, 400);
    }

    if (!noteText) {
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

    /*
     * Sicherheit für alte/manipulierte Daten.
     */
    if (
      existing.target_role ===
      "admin"
    ) {
      return json({
        ok:
          false,

        error:
          "Moderationsnotizen für Administratoren können nicht bearbeitet werden."
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
      admin.id,
      existing.target_user_id,
      "edit_moderation_note",
      {
        note_id:
          noteId,

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
        )
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
 *
 * Nur Admin.
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
      await requireAdmin(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return auth.response;
    }

    const admin =
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

    if (!noteId) {
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

    if (
      existing.target_role ===
      "admin"
    ) {
      return json({
        ok:
          false,

        error:
          "Moderationsnotizen für Administratoren können nicht gelöscht werden."
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
      admin.id,
      existing.target_user_id,
      "delete_moderation_note",
      {
        note_id:
          noteId,

        deleted_note:
          existing.note
      }
    );

    return json({
      ok:
        true,

      deleted:
        true,

      note_id:
        noteId
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

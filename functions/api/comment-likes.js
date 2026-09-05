function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

function getCookie(request, name) {
  const cookieHeader =
    request.headers.get("Cookie");

  if (!cookieHeader) {
    return null;
  }

  const cookies =
    cookieHeader.split(";");

  for (const cookie of cookies) {
    const [key, ...valueParts] =
      cookie.trim().split("=");

    if (key === name) {
      return valueParts.join("=");
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

  return await env.DB
    .prepare(`
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
}


/*
  ----------------------------------------------------
  FORUM-BANN
  ----------------------------------------------------

  Ein Forum-Bann ist ausschließlich eine
  Schreib-/Interaktionssperre.

  Gebannte Nutzer dürfen weiterhin:

  ✓ Forum lesen
  ✓ Beiträge lesen
  ✓ Kommentare lesen

  Gebannte Nutzer dürfen NICHT:

  ✗ Beiträge erstellen
  ✗ Antworten schreiben
  ✗ Beiträge liken / entliken
  ✗ Kommentare liken / entliken

  Administratoren sind geschützt.
*/

async function expireOldForumBans(env) {
  const now =
    Math.floor(Date.now() / 1000);

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

async function getActiveForumBan(
  env,
  user
) {
  if (!user) {
    return null;
  }

  /*
    Admins werden niemals durch einen
    Forum-Bann eingeschränkt.
  */
  if (user.role === "admin") {
    return null;
  }

  await expireOldForumBans(env);

  const now =
    Math.floor(Date.now() / 1000);

  const ban =
    await env.DB
      .prepare(`
        SELECT
          id,
          user_id,
          banned_by,
          reason,
          banned_at,
          expires_at,
          active
        FROM forum_bans
        WHERE user_id = ?
          AND active = 1
          AND (
            expires_at IS NULL
            OR expires_at > ?
          )
        ORDER BY banned_at DESC
        LIMIT 1
      `)
      .bind(
        user.id,
        now
      )
      .first();

  return ban || null;
}

function serializeForumBan(ban) {
  if (!ban) {
    return null;
  }

  const now =
    Math.floor(Date.now() / 1000);

  const expiresAt =
    ban.expires_at === null
      ? null
      : Number(ban.expires_at);

  return {
    id:
      Number(ban.id),

    reason:
      ban.reason || "",

    banned_at:
      Number(ban.banned_at),

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


// ----------------------------------------------------
// POST /api/comment-likes
// ----------------------------------------------------
//
// Kommentar liken oder Like wieder entfernen.
//
// Bei aktivem Forum-Bann wird BEIDES
// serverseitig verhindert.
// ----------------------------------------------------

export async function onRequestPost(context) {
  try {
    const {
      request,
      env
    } = context;

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json(
        {
          success: false,
          error:
            "Du musst angemeldet sein, um einen Kommentar zu liken."
        },
        401
      );
    }

    /*
      SERVERSEITIGE BANNPRÜFUNG

      Die Prüfung erfolgt vor jeder Änderung
      an comment_likes.

      Das bedeutet:
      Auch ein direkter API-Aufruf kann die
      Forum-Sperre nicht umgehen.
    */

    const forumBan =
      await getActiveForumBan(
        env,
        user
      );

    if (forumBan) {
      return json(
        {
          success: false,

          error:
            "Du bist aktuell im Forum gesperrt und kannst keine Kommentare liken.",

          code:
            "FORUM_BANNED",

          forum_banned:
            true,

          forum_ban:
            serializeForumBan(
              forumBan
            )
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
          success: false,
          error:
            "Ungültige Anfrage."
        },
        400
      );
    }

    const commentId =
      Number(
        body.comment_id
      );

    if (
      !Number.isInteger(commentId) ||
      commentId < 1
    ) {
      return json(
        {
          success: false,
          error:
            "Ungültige Kommentar-ID."
        },
        400
      );
    }

    /*
      Prüfen, ob der Kommentar existiert.
    */

    const comment =
      await env.DB
        .prepare(`
          SELECT
            id
          FROM comments
          WHERE id = ?
          LIMIT 1
        `)
        .bind(commentId)
        .first();

    if (!comment) {
      return json(
        {
          success: false,
          error:
            "Kommentar wurde nicht gefunden."
        },
        404
      );
    }

    /*
      Prüfen, ob der Nutzer diesen
      Kommentar bereits geliked hat.
    */

    const existingLike =
      await env.DB
        .prepare(`
          SELECT
            comment_id
          FROM comment_likes
          WHERE comment_id = ?
            AND user_id = ?
          LIMIT 1
        `)
        .bind(
          commentId,
          user.id
        )
        .first();

    let liked = false;

    if (existingLike) {

      /*
        Vorhandenen Like entfernen.
      */

      await env.DB
        .prepare(`
          DELETE FROM comment_likes
          WHERE comment_id = ?
            AND user_id = ?
        `)
        .bind(
          commentId,
          user.id
        )
        .run();

      liked = false;

    } else {

      /*
        Neuen Like setzen.
      */

      await env.DB
        .prepare(`
          INSERT INTO comment_likes (
            comment_id,
            user_id
          )
          VALUES (?, ?)
        `)
        .bind(
          commentId,
          user.id
        )
        .run();

      liked = true;
    }

    /*
      Aktuelle Like-Anzahl laden.
    */

    const countResult =
      await env.DB
        .prepare(`
          SELECT
            COUNT(*) AS count
          FROM comment_likes
          WHERE comment_id = ?
        `)
        .bind(commentId)
        .first();

    return json({
      success: true,

      liked,

      likes:
        Number(
          countResult?.count || 0
        )
    });

  } catch (error) {
    console.error(
      "COMMENT-LIKE ERROR:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Kommentar-Like konnte nicht verarbeitet werden."
      },
      500
    );
  }
}


// ----------------------------------------------------
// Andere Methoden nicht erlaubt
// ----------------------------------------------------

export async function onRequestGet() {
  return json(
    {
      success: false,
      error:
        "Method not allowed."
    },
    405
  );
}

export async function onRequestPut() {
  return json(
    {
      success: false,
      error:
        "Method not allowed."
    },
    405
  );
}

export async function onRequestPatch() {
  return json(
    {
      success: false,
      error:
        "Method not allowed."
    },
    405
  );
}

export async function onRequestDelete() {
  return json(
    {
      success: false,
      error:
        "Method not allowed."
    },
    405
  );
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8"
    }
  });
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie");

  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split("=");

    if (key === name) {
      return valueParts.join("=");
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

  return await env.DB
    .prepare(`
      SELECT users.id, users.username, users.server
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ?
      AND sessions.expires_at > ?
    `)
    .bind(sessionId, now)
    .first();
}


// ----------------------------------------------------
// POST /api/comment-likes
// Kommentar liken oder Like wieder entfernen
// ----------------------------------------------------

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const user = await getCurrentUser(request, env);

    if (!user) {
      return json({
        success: false,
        error: "Du musst angemeldet sein, um einen Kommentar zu liken."
      }, 401);
    }

    const body = await request.json();
    const commentId = Number(body.comment_id);

    if (!Number.isInteger(commentId) || commentId < 1) {
      return json({
        success: false,
        error: "Ungültige Kommentar-ID."
      }, 400);
    }

    // Prüfen, ob der Kommentar existiert
    const comment = await env.DB
      .prepare(`
        SELECT id
        FROM comments
        WHERE id = ?
      `)
      .bind(commentId)
      .first();

    if (!comment) {
      return json({
        success: false,
        error: "Kommentar wurde nicht gefunden."
      }, 404);
    }

    // Prüfen, ob der Benutzer bereits geliked hat
    const existingLike = await env.DB
      .prepare(`
        SELECT comment_id
        FROM comment_likes
        WHERE comment_id = ?
        AND user_id = ?
      `)
      .bind(commentId, user.id)
      .first();

    let liked = false;

    if (existingLike) {

      // Like entfernen
      await env.DB
        .prepare(`
          DELETE FROM comment_likes
          WHERE comment_id = ?
          AND user_id = ?
        `)
        .bind(commentId, user.id)
        .run();

      liked = false;

    } else {

      // Like hinzufügen
      await env.DB
        .prepare(`
          INSERT INTO comment_likes
          (comment_id, user_id)
          VALUES (?, ?)
        `)
        .bind(commentId, user.id)
        .run();

      liked = true;
    }

    // Aktuelle Anzahl Likes
    const countResult = await env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM comment_likes
        WHERE comment_id = ?
      `)
      .bind(commentId)
      .first();

    return json({
      success: true,
      liked: liked,
      likes: Number(countResult.count)
    });

  } catch (error) {
    console.error("COMMENT-LIKE ERROR:", error);

    return json({
      success: false,
      error: "Kommentar-Like konnte nicht verarbeitet werden."
    }, 500);
  }
}

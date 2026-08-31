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


// POST /api/post-like
export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const user = await getCurrentUser(request, env);

    if (!user) {
      return json({
        success: false,
        error: "Du musst angemeldet sein, um einen Beitrag zu liken."
      }, 401);
    }

    const body = await request.json();
    const postId = Number(body.post_id);

    if (!Number.isInteger(postId) || postId < 1) {
      return json({
        success: false,
        error: "Ungültige Beitrags-ID."
      }, 400);
    }

    const post = await env.DB
      .prepare(`
        SELECT id
        FROM posts
        WHERE id = ?
      `)
      .bind(postId)
      .first();

    if (!post) {
      return json({
        success: false,
        error: "Beitrag wurde nicht gefunden."
      }, 404);
    }

    const existingLike = await env.DB
      .prepare(`
        SELECT post_id
        FROM post_likes
        WHERE post_id = ?
        AND user_id = ?
      `)
      .bind(postId, user.id)
      .first();

    let liked;

    if (existingLike) {
      await env.DB
        .prepare(`
          DELETE FROM post_likes
          WHERE post_id = ?
          AND user_id = ?
        `)
        .bind(postId, user.id)
        .run();

      liked = false;

    } else {
      await env.DB
        .prepare(`
          INSERT INTO post_likes
          (post_id, user_id)
          VALUES (?, ?)
        `)
        .bind(postId, user.id)
        .run();

      liked = true;
    }

    const countResult = await env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM post_likes
        WHERE post_id = ?
      `)
      .bind(postId)
      .first();

    return json({
      success: true,
      liked,
      likes: Number(countResult.count)
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Like konnte nicht verarbeitet werden."
    }, 500);
  }
}

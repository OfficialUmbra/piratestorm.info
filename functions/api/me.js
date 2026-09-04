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


// ----------------------------------------------------
// GET /api/me
// Aktuellen Login-Status + Benutzerrolle abrufen
// ----------------------------------------------------

export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const sessionId = getCookie(request, "ps_session");

    if (!sessionId) {
      return json({
        success: true,
        loggedIn: false
      });
    }

    const now = Math.floor(Date.now() / 1000);

    const user = await env.DB
      .prepare(`
        SELECT
          users.id,
          users.username,
          users.server,
          users.role,
          users.avatar_symbol,
          users.avatar_color,
          sessions.expires_at
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.id = ?
        AND sessions.expires_at > ?
      `)
      .bind(sessionId, now)
      .first();

    if (!user) {
      await env.DB
        .prepare(`
          DELETE FROM sessions
          WHERE id = ?
        `)
        .bind(sessionId)
        .run();

      return json({
        success: true,
        loggedIn: false
      });
    }

    return json({
      success: true,
      loggedIn: true,
      user: {
        id: user.id,
        username: user.username,
        server: user.server,
        role: user.role,
        is_admin: user.role === "admin",
        avatar_symbol: user.avatar_symbol,
        avatar_color: user.avatar_color
      }
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Login-Status konnte nicht geprüft werden."
    }, 500);
  }
}

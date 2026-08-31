function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...headers
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

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const sessionId = getCookie(request, "ps_session");

    if (sessionId) {
      await env.DB
        .prepare(`
          DELETE FROM sessions
          WHERE id = ?
        `)
        .bind(sessionId)
        .run();
    }

    const expiredCookie = [
      "ps_session=",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=0"
    ].join("; ");

    return json({
      success: true,
      message: "Erfolgreich abgemeldet."
    }, 200, {
      "Set-Cookie": expiredCookie
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Beim Abmelden ist ein Fehler aufgetreten."
    }, 500);
  }
}

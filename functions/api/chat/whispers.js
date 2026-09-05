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
  const cookie =
    request.headers.get("Cookie") || "";

  for (const part of cookie.split(";")) {
    const [key, ...value] =
      part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(
        value.join("=")
      );
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

function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
}

function cleanText(value) {
  return typeof value === "string"
    ? value.trim()
    : "";
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

async function isRoomMember(
  env,
  roomId,
  userId
) {
  return await env.DB.prepare(`
    SELECT
      room_id,
      user_id,
      joined_at

    FROM whisper_members

    WHERE room_id = ?
      AND user_id = ?

    LIMIT 1
  `)
    .bind(
      roomId,
      userId
    )
    .first();
}

async function getRoom(
  env,
  roomId
) {
  return await env.DB.prepare(`
    SELECT
      id,
      created_by,
      name,
      created_at

    FROM whisper_rooms

    WHERE id = ?

    LIMIT 1
  `)
    .bind(roomId)
    .first();
}

async function getRoomMembers(
  env,
  roomId
) {
  const result =
    await env.DB.prepare(`
      SELECT
        u.id,
        u.username,
        u.server,
        u.role,
        wm.joined_at

      FROM whisper_members wm

      JOIN users u
        ON u.id = wm.user_id

      WHERE wm.room_id = ?

      ORDER BY
        wm.joined_at ASC,
        LOWER(u.username) ASC
    `)
      .bind(roomId)
      .all();

  return (
    result.results || []
  ).map(user => ({
    id:
      user.id,

    username:
      user.username,

    server:
      user.server,

    role:
      user.role,

    is_admin:
      user.role === "admin",

    joined_at:
      user.joined_at
  }));
}

async function usersBlockEachOther(
  env,
  userA,
  userB
) {
  const row =
    await env.DB.prepare(`
      SELECT id

      FROM chat_blocks

      WHERE
        (
          blocker_id = ?
          AND blocked_id = ?
        )
        OR
        (
          blocker_id = ?
          AND blocked_id = ?
        )

      LIMIT 1
    `)
      .bind(
        userA,
        userB,
        userB,
        userA
      )
      .first();

  return Boolean(row);
}

async function getRoomResponse(
  env,
  roomId
) {
  const room =
    await getRoom(
      env,
      roomId
    );

  if (!room) {
    return null;
  }

  const members =
    await getRoomMembers(
      env,
      roomId
    );

  return {
    id:
      room.id,

    created_by:
      room.created_by,

    name:
      room.name || null,

    created_at:
      room.created_at,

    members
  };
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Ohne room_id:
 *
 * - eigene Whisper-Räume
 * - offene Einladungen
 *
 * Mit room_id:
 *
 * - Nachrichten eines eigenen Whisper-Raumes
 *
 * WICHTIG:
 * Auch Admins haben KEINEN automatischen Zugriff auf
 * fremde private Whisper-Chats.
 */
export async function onRequestGet(context) {
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
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    const url =
      new URL(request.url);

    const roomId =
      toPositiveInt(
        url.searchParams.get(
          "room_id"
        )
      );

    /*
     * =================================================
     * EINEN WHISPER-RAUM LADEN
     * =================================================
     */
    if (roomId) {
      const membership =
        await isRoomMember(
          env,
          roomId,
          user.id
        );

      if (!membership) {
        return json({
          ok: false,
          error:
            "Du bist kein Mitglied dieses Whisper-Chats."
        }, 403);
      }

      const room =
        await getRoomResponse(
          env,
          roomId
        );

      if (!room) {
        return json({
          ok: false,
          error:
            "Whisper-Chat wurde nicht gefunden."
        }, 404);
      }

      const messagesResult =
        await env.DB.prepare(`
          SELECT
            wm.id,
            wm.room_id,
            wm.user_id,
            wm.message,
            wm.original_message,
            wm.reply_to,
            wm.created_at,
            wm.deleted_at,

            u.username,
            u.server,
            u.role,

            reply_user.username
              AS reply_username,

            reply_message.message
              AS reply_message,

            reply_message.original_message
              AS reply_original_message

          FROM whisper_messages wm

          JOIN users u
            ON u.id = wm.user_id

          LEFT JOIN whisper_messages reply_message
            ON reply_message.id =
              wm.reply_to

          LEFT JOIN users reply_user
            ON reply_user.id =
              reply_message.user_id

          WHERE wm.room_id = ?
            AND wm.deleted_at IS NULL

          ORDER BY
            wm.created_at ASC,
            wm.id ASC

          LIMIT 500
        `)
          .bind(roomId)
          .all();

      const messages =
        (
          messagesResult.results || []
        ).map(message => ({
          id:
            message.id,

          room_id:
            message.room_id,

          user_id:
            message.user_id,

          username:
            message.username,

          server:
            message.server,

          role:
            message.role,

          is_admin:
            message.role === "admin",

          message:
            message.message,

          content:
            message.message,

          reply_to:
            message.reply_to || null,

          reply_username:
            message.reply_username || null,

          reply_excerpt:
            message.reply_to
              ? (
                  message.reply_message ||
                  message.reply_original_message ||
                  ""
                ).slice(0, 120)
              : null,

          created_at:
            message.created_at
        }));

      return json({
        ok: true,

        room,

        messages
      });
    }

    /*
     * =================================================
     * EIGENE RÄUME
     * =================================================
     */
    const roomsResult =
      await env.DB.prepare(`
        SELECT
          wr.id,
          wr.created_by,
          wr.name,
          wr.created_at,
          wm.joined_at

        FROM whisper_members wm

        JOIN whisper_rooms wr
          ON wr.id = wm.room_id

        WHERE wm.user_id = ?

        ORDER BY
          wr.created_at DESC,
          wr.id DESC
      `)
        .bind(user.id)
        .all();

    const rooms = [];

    for (
      const room
      of roomsResult.results || []
    ) {
      const members =
        await getRoomMembers(
          env,
          room.id
        );

      rooms.push({
        id:
          room.id,

        created_by:
          room.created_by,

        name:
          room.name || null,

        created_at:
          room.created_at,

        joined_at:
          room.joined_at,

        members
      });
    }

    /*
     * =================================================
     * OFFENE EINLADUNGEN
     * =================================================
     */
    const invitesResult =
      await env.DB.prepare(`
        SELECT
          wi.id,
          wi.room_id,
          wi.inviter_id,
          wi.invited_user_id,
          wi.status,
          wi.created_at,

          inviter.username
            AS inviter_username,

          inviter.server
            AS inviter_server,

          inviter.role
            AS inviter_role,

          wr.name
            AS room_name

        FROM whisper_invites wi

        JOIN users inviter
          ON inviter.id =
            wi.inviter_id

        JOIN whisper_rooms wr
          ON wr.id =
            wi.room_id

        WHERE wi.invited_user_id = ?
          AND wi.status = 'pending'

        ORDER BY
          wi.created_at DESC,
          wi.id DESC
      `)
        .bind(user.id)
        .all();

    const invites =
      (
        invitesResult.results || []
      ).map(invite => ({
        id:
          invite.id,

        room_id:
          invite.room_id,

        status:
          invite.status,

        created_at:
          invite.created_at,

        room_name:
          invite.room_name || null,

        inviter: {
          id:
            invite.inviter_id,

          username:
            invite.inviter_username,

          server:
            invite.inviter_server,

          role:
            invite.inviter_role,

          is_admin:
            invite.inviter_role ===
            "admin"
        }
      }));

    return json({
      ok: true,

      rooms,

      invites
    });

  } catch (error) {
    console.error(
      "GET /api/chat/whispers error:",
      error
    );

    return json({
      ok: false,
      error:
        "Whisper-Daten konnten nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST
 * =====================================================
 *
 * Aktionen:
 *
 * create
 * send
 */
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
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json({
        ok: false,
        error:
          "Ungültige Anfrage."
      }, 400);
    }

    const action =
      cleanText(
        body.action
      ).toLowerCase();

    /*
     * =================================================
     * WHISPER ERSTELLEN
     * =================================================
     *
     * Creator wird sofort Mitglied.
     *
     * Eingeladene Spieler werden NICHT automatisch
     * Mitglied. Sie bekommen zunächst eine Einladung.
     */
    if (action === "create") {
      const rawIds =
        Array.isArray(
          body.invited_user_ids
        )
          ? body.invited_user_ids
          : [];

      const invitedIds =
        [
          ...new Set(
            rawIds
              .map(toPositiveInt)
              .filter(Boolean)
          )
        ].filter(
          id =>
            Number(id) !==
            Number(user.id)
        );

      /*
       * Creator + maximal 4 weitere Spieler
       * = maximal 5 Spieler.
       */
      if (
        invitedIds.length < 1 ||
        invitedIds.length > 4
      ) {
        return json({
          ok: false,
          error:
            "Ein Whisper-Chat benötigt 2 bis 5 Spieler."
        }, 400);
      }

      const invitedUsers = [];

      for (
        const invitedId
        of invitedIds
      ) {
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
            .bind(invitedId)
            .first();

        if (!target) {
          return json({
            ok: false,
            error:
              "Mindestens ein ausgewählter Spieler wurde nicht gefunden."
          }, 404);
        }

        /*
         * Whisper nur innerhalb desselben Servers.
         *
         * Admin-Sonderrechte gelten hier bewusst
         * NICHT für private Whisper-Chats.
         */
        if (
          target.server !==
          user.server
        ) {
          return json({
            ok: false,
            error:
              "Whisper ist nur mit Spielern desselben Servers möglich."
          }, 403);
        }

        /*
         * Niemand darf Admin blockieren.
         * Falls dennoch alte Block-Daten existieren,
         * soll das Admin-Konto dadurch nicht
         * eingeschränkt werden.
         */
        if (
          !isAdmin(user) &&
          !isAdmin(target)
        ) {
          const blocked =
            await usersBlockEachOther(
              env,
              user.id,
              target.id
            );

          if (blocked) {
            return json({
              ok: false,
              error:
                `Whisper mit ${target.username} ist wegen einer Blockierung nicht möglich.`
            }, 403);
          }
        }

        invitedUsers.push(
          target
        );
      }

      const name =
        cleanText(
          body.name
        ).slice(0, 50);

      const now =
        Math.floor(
          Date.now() / 1000
        );

      const created =
        await env.DB.prepare(`
          INSERT INTO whisper_rooms (
            created_by,
            name,
            created_at
          )

          VALUES (?, ?, ?)

          RETURNING id
        `)
          .bind(
            user.id,
            name || null,
            now
          )
          .first();

      if (!created?.id) {
        return json({
          ok: false,
          error:
            "Whisper-Chat konnte nicht erstellt werden."
        }, 500);
      }

      const roomId =
        created.id;

      /*
       * Ersteller ist sofort Mitglied.
       */
      await env.DB.prepare(`
        INSERT INTO whisper_members (
          room_id,
          user_id,
          joined_at
        )

        VALUES (?, ?, ?)
      `)
        .bind(
          roomId,
          user.id,
          now
        )
        .run();

      /*
       * Für alle anderen werden Einladungen erzeugt.
       */
      for (
        const target
        of invitedUsers
      ) {
        await env.DB.prepare(`
          INSERT INTO whisper_invites (
            room_id,
            inviter_id,
            invited_user_id,
            status,
            created_at
          )

          VALUES (?, ?, ?, 'pending', ?)
        `)
          .bind(
            roomId,
            user.id,
            target.id,
            now
          )
          .run();
      }

      const room =
        await getRoomResponse(
          env,
          roomId
        );

      return json({
        ok: true,

        room,

        invited_users:
          invitedUsers.map(
            target => ({
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
                "admin"
            })
          )
      }, 201);
    }

    /*
     * =================================================
     * NACHRICHT SENDEN
     * =================================================
     */
    if (action === "send") {
      const roomId =
        toPositiveInt(
          body.room_id
        );

      if (!roomId) {
        return json({
          ok: false,
          error:
            "Ungültiger Whisper-Chat."
        }, 400);
      }

      const membership =
        await isRoomMember(
          env,
          roomId,
          user.id
        );

      if (!membership) {
        return json({
          ok: false,
          error:
            "Du bist kein Mitglied dieses Whisper-Chats."
        }, 403);
      }

      const message =
        cleanText(
          body.message
        );

      if (!message) {
        return json({
          ok: false,
          error:
            "Die Nachricht darf nicht leer sein."
        }, 400);
      }

      if (
        message.length > 1000
      ) {
        return json({
          ok: false,
          error:
            "Die Nachricht ist zu lang."
        }, 400);
      }

      /*
       * Prüfen, ob zwischen Sender und einem anderen
       * aktuellen Mitglied eine Blockierung besteht.
       */
      const members =
        await getRoomMembers(
          env,
          roomId
        );

      for (
        const member
        of members
      ) {
        if (
          Number(member.id) ===
          Number(user.id)
        ) {
          continue;
        }

        if (
          isAdmin(user) ||
          member.is_admin
        ) {
          continue;
        }

        const blocked =
          await usersBlockEachOther(
            env,
            user.id,
            member.id
          );

        if (blocked) {
          return json({
            ok: false,
            error:
              "Die Nachricht kann wegen einer Blockierung nicht gesendet werden."
          }, 403);
        }
      }

      let replyTo = null;

      if (
        body.reply_to !== null &&
        body.reply_to !== undefined &&
        body.reply_to !== ""
      ) {
        replyTo =
          toPositiveInt(
            body.reply_to
          );

        if (!replyTo) {
          return json({
            ok: false,
            error:
              "Ungültige Antwort-Nachricht."
          }, 400);
        }

        const replyMessage =
          await env.DB.prepare(`
            SELECT
              id,
              room_id

            FROM whisper_messages

            WHERE id = ?
              AND room_id = ?
              AND deleted_at IS NULL

            LIMIT 1
          `)
            .bind(
              replyTo,
              roomId
            )
            .first();

        if (!replyMessage) {
          return json({
            ok: false,
            error:
              "Die Nachricht, auf die du antworten möchtest, wurde nicht gefunden."
          }, 404);
        }
      }

      const now =
        Math.floor(
          Date.now() / 1000
        );

      /*
       * original_message bleibt für spätere
       * Moderations-/Filterfunktionen erhalten.
       *
       * Aktuell findet keine automatische
       * Sprachübersetzung statt.
       */
      const inserted =
        await env.DB.prepare(`
          INSERT INTO whisper_messages (
            room_id,
            user_id,
            message,
            original_message,
            reply_to,
            created_at
          )

          VALUES (?, ?, ?, ?, ?, ?)

          RETURNING id
        `)
          .bind(
            roomId,
            user.id,
            message,
            message,
            replyTo,
            now
          )
          .first();

      /*
       * Eigene Nachricht direkt als gelesen markieren.
       */
      if (inserted?.id) {
        await env.DB.prepare(`
          INSERT INTO whisper_read_state (
            room_id,
            user_id,
            last_read_message_id,
            updated_at
          )

          VALUES (?, ?, ?, ?)

          ON CONFLICT(room_id, user_id)

          DO UPDATE SET
            last_read_message_id =
              excluded.last_read_message_id,

            updated_at =
              excluded.updated_at
        `)
          .bind(
            roomId,
            user.id,
            inserted.id,
            now
          )
          .run();
      }

      return json({
        ok: true,

        message: {
          id:
            inserted?.id || null,

          room_id:
            roomId,

          user_id:
            user.id,

          username:
            user.username,

          server:
            user.server,

          role:
            user.role,

          is_admin:
            isAdmin(user),

          message,

          content:
            message,

          reply_to:
            replyTo,

          created_at:
            now
        }
      }, 201);
    }

    return json({
      ok: false,
      error:
        "Ungültige Whisper Aktion."
    }, 400);

  } catch (error) {
    console.error(
      "POST /api/chat/whispers error:",
      error
    );

    return json({
      ok: false,
      error:
        "Whisper-Aktion konnte nicht ausgeführt werden."
    }, 500);
  }
}

/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * Einladung annehmen / ablehnen.
 *
 * {
 *   "invite_id": 123,
 *   "response": "accepted"
 * }
 *
 * oder:
 *
 * {
 *   "invite_id": 123,
 *   "response": "declined"
 * }
 */
export async function onRequestPut(context) {
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
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json({
        ok: false,
        error:
          "Ungültige Anfrage."
      }, 400);
    }

    const inviteId =
      toPositiveInt(
        body.invite_id
      );

    const response =
      cleanText(
        body.response
      ).toLowerCase();

    if (!inviteId) {
      return json({
        ok: false,
        error:
          "Ungültige Einladung."
      }, 400);
    }

    if (
      response !== "accepted" &&
      response !== "declined"
    ) {
      return json({
        ok: false,
        error:
          "Ungültige Antwort auf die Einladung."
      }, 400);
    }

    const invite =
      await env.DB.prepare(`
        SELECT
          wi.id,
          wi.room_id,
          wi.inviter_id,
          wi.invited_user_id,
          wi.status,

          inviter.server
            AS inviter_server,

          inviter.role
            AS inviter_role

        FROM whisper_invites wi

        JOIN users inviter
          ON inviter.id =
            wi.inviter_id

        WHERE wi.id = ?
          AND wi.invited_user_id = ?

        LIMIT 1
      `)
        .bind(
          inviteId,
          user.id
        )
        .first();

    if (!invite) {
      return json({
        ok: false,
        error:
          "Einladung wurde nicht gefunden."
      }, 404);
    }

    if (
      invite.status !== "pending"
    ) {
      return json({
        ok: false,
        error:
          "Diese Einladung wurde bereits beantwortet."
      }, 409);
    }

    /*
     * =================================================
     * ABLEHNEN
     * =================================================
     */
    if (
      response === "declined"
    ) {
      await env.DB.prepare(`
        UPDATE whisper_invites

        SET status = 'declined'

        WHERE id = ?
          AND invited_user_id = ?
          AND status = 'pending'
      `)
        .bind(
          inviteId,
          user.id
        )
        .run();

      return json({
        ok: true,

        invite_id:
          inviteId,

        status:
          "declined"
      });
    }

    /*
     * =================================================
     * ANNEHMEN
     * =================================================
     */

    const room =
      await getRoom(
        env,
        invite.room_id
      );

    if (!room) {
      return json({
        ok: false,
        error:
          "Der Whisper-Chat existiert nicht mehr."
      }, 404);
    }

    /*
     * Gleicher Server bleibt Pflicht.
     */
    if (
      invite.inviter_server !==
      user.server
    ) {
      return json({
        ok: false,
        error:
          "Dieser Whisper-Chat gehört nicht zu deinem Server."
      }, 403);
    }

    /*
     * Blockierung erneut prüfen.
     */
    if (
      !isAdmin(user) &&
      invite.inviter_role !==
      "admin"
    ) {
      const blocked =
        await usersBlockEachOther(
          env,
          user.id,
          invite.inviter_id
        );

      if (blocked) {
        return json({
          ok: false,
          error:
            "Die Einladung kann wegen einer Blockierung nicht angenommen werden."
        }, 403);
      }
    }

    /*
     * Maximal 5 Mitglieder.
     */
    const memberCount =
      await env.DB.prepare(`
        SELECT
          COUNT(*) AS count

        FROM whisper_members

        WHERE room_id = ?
      `)
        .bind(
          invite.room_id
        )
        .first();

    if (
      Number(
        memberCount?.count || 0
      ) >= 5
    ) {
      return json({
        ok: false,
        error:
          "Dieser Whisper-Chat ist bereits voll."
      }, 409);
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    await env.DB.prepare(`
      INSERT OR IGNORE INTO whisper_members (
        room_id,
        user_id,
        joined_at
      )

      VALUES (?, ?, ?)
    `)
      .bind(
        invite.room_id,
        user.id,
        now
      )
      .run();

    await env.DB.prepare(`
      UPDATE whisper_invites

      SET status = 'accepted'

      WHERE id = ?
        AND invited_user_id = ?
        AND status = 'pending'
    `)
      .bind(
        inviteId,
        user.id
      )
      .run();

    const acceptedRoom =
      await getRoomResponse(
        env,
        invite.room_id
      );

    return json({
      ok: true,

      invite_id:
        inviteId,

      status:
        "accepted",

      room:
        acceptedRoom
    });

  } catch (error) {
    console.error(
      "PUT /api/chat/whispers error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Whisper-Einladung konnte nicht verarbeitet werden."
    }, 500);
  }
}

/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * WHISPER VERLASSEN
 *
 * Aufruf:
 *
 * DELETE /api/chat/whispers?room_id=123
 *
 * Der eingeloggte Spieler wird aus dem Raum entfernt.
 *
 * - Pending Invites für diesen Spieler werden beendet.
 * - Read-State wird entfernt.
 * - Wenn niemand mehr Mitglied ist, wird der komplette
 *   Whisper-Raum inklusive Nachrichten/Invites
 *   aufgeräumt.
 *
 * Private Nachrichten können dadurch nicht plötzlich
 * von Admins eingesehen werden.
 */
export async function onRequestDelete(context) {
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
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    const url =
      new URL(request.url);

    const roomId =
      toPositiveInt(
        url.searchParams.get(
          "room_id"
        )
      );

    if (!roomId) {
      return json({
        ok: false,
        error:
          "Ungültiger Whisper-Chat."
      }, 400);
    }

    const membership =
      await isRoomMember(
        env,
        roomId,
        user.id
      );

    if (!membership) {
      return json({
        ok: false,
        error:
          "Du bist kein Mitglied dieses Whisper-Chats."
      }, 403);
    }

    /*
     * Eigene Mitgliedschaft entfernen.
     */
    await env.DB.prepare(`
      DELETE FROM whisper_members

      WHERE room_id = ?
        AND user_id = ?
    `)
      .bind(
        roomId,
        user.id
      )
      .run();

    /*
     * Read-State entfernen.
     */
    await env.DB.prepare(`
      DELETE FROM whisper_read_state

      WHERE room_id = ?
        AND user_id = ?
    `)
      .bind(
        roomId,
        user.id
      )
      .run();

    /*
     * Eventuell noch vorhandene eigene offene
     * Einladung abschließen.
     */
    await env.DB.prepare(`
      UPDATE whisper_invites

      SET status = 'declined'

      WHERE room_id = ?
        AND invited_user_id = ?
        AND status = 'pending'
    `)
      .bind(
        roomId,
        user.id
      )
      .run();

    const remaining =
      await env.DB.prepare(`
        SELECT
          COUNT(*) AS count

        FROM whisper_members

        WHERE room_id = ?
      `)
        .bind(roomId)
        .first();

    const remainingCount =
      Number(
        remaining?.count || 0
      );

    /*
     * =================================================
     * RAUM IST LEER
     * =================================================
     *
     * Wegen der Foreign Keys räumen wir in sinnvoller
     * Reihenfolge auf.
     */
    if (
      remainingCount === 0
    ) {
      await env.DB.prepare(`
        DELETE FROM whisper_read_state

        WHERE room_id = ?
      `)
        .bind(roomId)
        .run();

      /*
       * Reports können auf Whisper-Nachrichten zeigen.
       * Deshalb löschen wir einen leeren Raum nicht
       * blind, falls bereits Moderationsmeldungen zu
       * Nachrichten daraus existieren.
       *
       * In diesem Fall bleibt der Raum technisch in
       * der DB erhalten, hat aber keine Mitglieder
       * mehr und ist somit für niemanden zugänglich.
       */
      const reportCount =
        await env.DB.prepare(`
          SELECT
            COUNT(*) AS count

          FROM chat_reports

          WHERE report_type = 'whisper'
            AND whisper_message_id IN (
              SELECT id

              FROM whisper_messages

              WHERE room_id = ?
            )
        `)
          .bind(roomId)
          .first();

      if (
        Number(
          reportCount?.count || 0
        ) === 0
      ) {
        await env.DB.prepare(`
          DELETE FROM whisper_invites

          WHERE room_id = ?
        `)
          .bind(roomId)
          .run();

        /*
         * Replies innerhalb desselben Raumes zeigen
         * ebenfalls auf whisper_messages.
         *
         * Deshalb zuerst reply_to lösen.
         */
        await env.DB.prepare(`
          UPDATE whisper_messages

          SET reply_to = NULL

          WHERE room_id = ?
        `)
          .bind(roomId)
          .run();

        await env.DB.prepare(`
          DELETE FROM whisper_messages

          WHERE room_id = ?
        `)
          .bind(roomId)
          .run();

        await env.DB.prepare(`
          DELETE FROM whisper_rooms

          WHERE id = ?
        `)
          .bind(roomId)
          .run();

        return json({
          ok: true,

          left:
            true,

          room_id:
            roomId,

          room_deleted:
            true,

          message:
            "Whisper-Chat wurde verlassen und entfernt."
        });
      }

      return json({
        ok: true,

        left:
          true,

        room_id:
          roomId,

        room_deleted:
          false,

        archived:
          true,

        message:
          "Whisper-Chat wurde verlassen."
      });
    }

    return json({
      ok: true,

      left:
        true,

      room_id:
        roomId,

      room_deleted:
        false,

      remaining_members:
        remainingCount,

      message:
        "Whisper-Chat wurde verlassen."
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/whispers error:",
      error
    );

    return json({
      ok: false,
      error:
        "Der Whisper-Chat konnte nicht verlassen werden."
    }, 500);
  }
}

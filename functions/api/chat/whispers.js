const MAX_ROOM_MEMBERS = 5;
const MAX_MESSAGE_LENGTH = 500;
const MAX_ROOM_NAME_LENGTH = 50;

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
  const cookie = request.headers.get("Cookie") || "";

  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(value.join("="));
    }
  }

  return null;
}

async function getCurrentUser(request, env) {
  const token = getCookie(request, "ps_session");

  if (!token) {
    return null;
  }

  return await env.DB.prepare(`
    SELECT
      users.id,
      users.username,
      users.server,
      users.role
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `)
    .bind(token, Math.floor(Date.now() / 1000))
    .first();
}

function isAdmin(user) {
  return Boolean(user && user.role === "admin");
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

/*
 * =====================================================
 * WORTFILTER
 * =====================================================
 *
 * message = gefilterte sichtbare Version
 * original_message = unveränderter Originaltext
 *
 * Das ist weiterhin nur der Basisfilter.
 */
function censorMessage(text) {
  const blockedWords = [
    "arschloch",
    "hurensohn",
    "wichser",
    "fotze",
    "missgeburt"
  ];

  let result = text;

  for (const word of blockedWords) {
    const escaped =
      word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const regex =
      new RegExp(`\\b${escaped}\\b`, "giu");

    result =
      result.replace(
        regex,
        match => "*".repeat(match.length)
      );
  }

  return result;
}

async function getUserById(env, userId) {
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
    .bind(userId)
    .first();
}

async function cleanupExpiredBans(env) {
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(`
    UPDATE chat_bans
    SET active = 0
    WHERE active = 1
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `)
    .bind(now)
    .run();
}

/*
 * Admin ist grundsätzlich immun.
 */
async function getActiveBan(env, user) {
  if (!user || isAdmin(user)) {
    return null;
  }

  await cleanupExpiredBans(env);

  const now = Math.floor(Date.now() / 1000);

  return await env.DB.prepare(`
    SELECT
      id,
      reason,
      banned_at,
      expires_at
    FROM chat_bans
    WHERE user_id = ?
      AND active = 1
      AND (
        expires_at IS NULL
        OR expires_at > ?
      )
    ORDER BY banned_at DESC, id DESC
    LIMIT 1
  `)
    .bind(user.id, now)
    .first();
}

async function ensureNotBanned(env, user) {
  if (isAdmin(user)) {
    return { ok: true };
  }

  const ban = await getActiveBan(env, user);

  if (!ban) {
    return { ok: true };
  }

  return {
    ok: false,
    response: json({
      ok: false,
      error: "Du bist derzeit vom Chat ausgeschlossen.",
      ban: {
        id: ban.id,
        reason: ban.reason || null,
        banned_at: ban.banned_at,
        expires_at: ban.expires_at,
        permanent: ban.expires_at === null
      }
    }, 403)
  };
}

/*
 * =====================================================
 * BLOCK-PRÜFUNG
 * =====================================================
 *
 * Admin kann niemals wirksam blockiert werden.
 *
 * Auch alte/manipulierte DB-Einträge gegen einen
 * Admin werden hier ignoriert.
 */
async function hasBlockBetween(env, userAId, userBId) {
  const userA = await getUserById(env, userAId);
  const userB = await getUserById(env, userBId);

  if (!userA || !userB) {
    return false;
  }

  if (isAdmin(userA) || isAdmin(userB)) {
    return false;
  }

  const block = await env.DB.prepare(`
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
      userAId,
      userBId,
      userBId,
      userAId
    )
    .first();

  return Boolean(block);
}

async function isRoomMember(env, roomId, userId) {
  const member = await env.DB.prepare(`
    SELECT 1 AS found
    FROM whisper_members
    WHERE room_id = ?
      AND user_id = ?
    LIMIT 1
  `)
    .bind(roomId, userId)
    .first();

  return Boolean(member);
}

async function getRoom(env, roomId) {
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

async function getRoomMembers(env, roomId) {
  const result = await env.DB.prepare(`
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
    ORDER BY wm.joined_at ASC
  `)
    .bind(roomId)
    .all();

  return result.results || [];
}

async function getPendingInviteCount(env, roomId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM whisper_invites
    WHERE room_id = ?
      AND status = 'pending'
  `)
    .bind(roomId)
    .first();

  return Number(row?.total || 0);
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Ohne room_id:
 * eigene Räume + Einladungen
 *
 * Mit room_id:
 * Nachrichten eines Whisper-Raums
 *
 * KEIN Admin-Bypass.
 */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(request, env);

    if (!user) {
      return json({
        ok: false,
        error: "Du musst eingeloggt sein."
      }, 401);
    }

    const banCheck =
      await ensureNotBanned(env, user);

    if (!banCheck.ok) {
      return banCheck.response;
    }

    const url = new URL(request.url);

    const roomIdRaw =
      url.searchParams.get("room_id");

    /*
     * =============================================
     * RAUMLISTE + EINLADUNGEN
     * =============================================
     */
    if (!roomIdRaw) {
      const roomsResult =
        await env.DB.prepare(`
          SELECT
            wr.id,
            wr.created_by,
            wr.name,
            wr.created_at
          FROM whisper_rooms wr
          JOIN whisper_members wm
            ON wm.room_id = wr.id
          WHERE wm.user_id = ?
          ORDER BY wr.created_at DESC
        `)
          .bind(user.id)
          .all();

      const rooms = [];

      for (const room of roomsResult.results || []) {
        const members =
          await getRoomMembers(env, room.id);

        rooms.push({
          id: room.id,
          name: room.name || null,
          created_by: room.created_by,
          created_at: room.created_at,

          members: members.map(member => ({
            id: member.id,
            username: member.username,
            server: member.server,
            role: member.role,
            is_admin: member.role === "admin"
          })),

          /*
           * Wird später durch echtes Read-State-System
           * ersetzt.
           */
          unread: 0
        });
      }

      const invitesResult =
        await env.DB.prepare(`
          SELECT
            wi.id,
            wi.room_id,
            wi.inviter_id,
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
            ON inviter.id = wi.inviter_id

          JOIN whisper_rooms wr
            ON wr.id = wi.room_id

          WHERE wi.invited_user_id = ?
            AND wi.status = 'pending'

          ORDER BY wi.created_at DESC
        `)
          .bind(user.id)
          .all();

      return json({
        ok: true,

        rooms,

        invites:
          (invitesResult.results || []).map(invite => ({
            id: invite.id,
            room_id: invite.room_id,
            room_name: invite.room_name,

            inviter: {
              id: invite.inviter_id,
              username: invite.inviter_username,
              server: invite.inviter_server,
              role: invite.inviter_role,
              is_admin:
                invite.inviter_role === "admin"
            },

            created_at: invite.created_at
          }))
      });
    }

    const roomId = Number(roomIdRaw);

    if (
      !Number.isInteger(roomId) ||
      roomId <= 0
    ) {
      return json({
        ok: false,
        error: "Ungültiger Whisper-Raum."
      }, 400);
    }

    const room =
      await getRoom(env, roomId);

    if (!room) {
      return json({
        ok: false,
        error: "Whisper-Raum wurde nicht gefunden."
      }, 404);
    }

    /*
     * =================================================
     * PRIVATSPHÄRE
     * =================================================
     *
     * KEIN Admin-Sonderzugriff.
     *
     * Auch Umbra muss Mitglied sein.
     */
    const member =
      await isRoomMember(
        env,
        roomId,
        user.id
      );

    if (!member) {
      return json({
        ok: false,
        error:
          "Du hast keinen Zugriff auf diesen Whisper-Chat."
      }, 403);
    }

    const limitRaw =
      Number(
        url.searchParams.get("limit") || 100
      );

    const limit =
      Number.isFinite(limitRaw)
        ? Math.max(
            1,
            Math.min(
              Math.floor(limitRaw),
              200
            )
          )
        : 100;

    const members =
      await getRoomMembers(env, roomId);

    /*
     * Zusätzliche Integritätsprüfung:
     * Ein Whisper-Raum darf keine Server mischen.
     */
    for (const roomMember of members) {
      if (roomMember.server !== user.server) {
        return json({
          ok: false,
          error:
            "Dieser Whisper-Chat enthält eine ungültige Serverkombination."
        }, 403);
      }
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

          reply.id
            AS reply_id,

          reply.message
            AS reply_message,

          reply.deleted_at
            AS reply_deleted_at,

          reply_user.username
            AS reply_username

        FROM whisper_messages wm

        JOIN users u
          ON u.id = wm.user_id

        LEFT JOIN whisper_messages reply
          ON reply.id = wm.reply_to
          AND reply.room_id = wm.room_id

        LEFT JOIN users reply_user
          ON reply_user.id = reply.user_id

        WHERE wm.room_id = ?

        ORDER BY
          wm.created_at DESC,
          wm.id DESC

        LIMIT ?
      `)
        .bind(roomId, limit)
        .all();

    const rawMessages =
      (messagesResult.results || []).reverse();

    return json({
      ok: true,

      room: {
        id: room.id,
        name: room.name,
        created_by: room.created_by,
        created_at: room.created_at,

        /*
         * Whisper-Standardsprache:
         * DE1 = Deutsch
         * alle anderen Server = Englisch
         */
        default_language:
          user.server === "Deutschland 1"
            ? "de"
            : "en",

        members:
          members.map(member => ({
            id: member.id,
            username: member.username,
            server: member.server,
            role: member.role,
            is_admin:
              member.role === "admin"
          }))
      },

      messages:
        rawMessages.map(message => ({
          id: message.id,
          room_id: message.room_id,

          user: {
            id: message.user_id,
            username: message.username,
            server: message.server,
            role: message.role,
            is_admin:
              message.role === "admin"
          },

          /*
           * Gelöschte Nachrichten bleiben als
           * Platzhalter im Verlauf vorhanden.
           */
          message:
            message.deleted_at
              ? null
              : message.message,

          /*
           * Nur tatsächliche Mitglieder dieses
           * privaten Raums erreichen diesen Code.
           *
           * Daher darf hier der echte Originaltext
           * für "Originalnachricht anzeigen"
           * mitgeliefert werden.
           */
          original_message:
            message.deleted_at
              ? null
              : (
                  message.original_message ||
                  message.message
                ),

          reply_to:
            message.reply_id
              ? {
                  id: message.reply_id,

                  username:
                    message.reply_username,

                  message:
                    message.reply_deleted_at
                      ? null
                      : message.reply_message,

                  deleted:
                    Boolean(
                      message.reply_deleted_at
                    )
                }
              : null,

          created_at:
            message.created_at,

          deleted:
            Boolean(message.deleted_at)
        }))
    });

  } catch (error) {
    console.error(
      "GET /api/chat/whispers error:",
      error
    );

    return json({
      ok: false,
      error:
        "Whisper-Chats konnten nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST
 * =====================================================
 *
 * actions:
 * create
 * send
 * invite
 */
export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(request, env);

    if (!user) {
      return json({
        ok: false,
        error: "Du musst eingeloggt sein."
      }, 401);
    }

    const banCheck =
      await ensureNotBanned(env, user);

    if (!banCheck.ok) {
      return banCheck.response;
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({
        ok: false,
        error: "Ungültige Anfrage."
      }, 400);
    }

    const action =
      typeof body.action === "string"
        ? body.action.trim().toLowerCase()
        : "";

    /*
     * =============================================
     * CREATE
     * =============================================
     */
    if (action === "create") {
      const name =
        normalizeText(body.name);

      if (
        name.length >
        MAX_ROOM_NAME_LENGTH
      ) {
        return json({
          ok: false,
          error:
            `Der Gruppenname darf maximal ${MAX_ROOM_NAME_LENGTH} Zeichen lang sein.`
        }, 400);
      }

      if (
        !Array.isArray(
          body.invited_user_ids
        )
      ) {
        return json({
          ok: false,
          error:
            "Es muss mindestens ein Spieler eingeladen werden."
        }, 400);
      }

      const uniqueInviteIds = [
        ...new Set(
          body.invited_user_ids
            .map(Number)
            .filter(id =>
              Number.isInteger(id) &&
              id > 0 &&
              id !== user.id
            )
        )
      ];

      if (
        uniqueInviteIds.length < 1 ||
        uniqueInviteIds.length > 4
      ) {
        return json({
          ok: false,
          error:
            "Ein Whisper-Chat muss insgesamt 2 bis 5 Spieler haben."
        }, 400);
      }

      const invitedUsers = [];

      for (const invitedId of uniqueInviteIds) {
        const invitedUser =
          await getUserById(
            env,
            invitedId
          );

        if (!invitedUser) {
          return json({
            ok: false,
            error:
              `Spieler-ID ${invitedId} wurde nicht gefunden.`
          }, 404);
        }

        /*
         * Whisper bleibt servergebunden.
         */
        if (
          invitedUser.server !==
          user.server
        ) {
          return json({
            ok: false,
            error:
              `${invitedUser.username} spielt auf einem anderen Server.`
          }, 403);
        }

        /*
         * hasBlockBetween berücksichtigt
         * Admin-Immunität bereits zentral.
         */
        const blocked =
          await hasBlockBetween(
            env,
            user.id,
            invitedUser.id
          );

        if (blocked) {
          return json({
            ok: false,
            error:
              `Mit ${invitedUser.username} kann derzeit kein Whisper-Chat gestartet werden.`
          }, 403);
        }

        /*
         * Admin kann niemals als gebannt gelten.
         */
        const invitedBan =
          await getActiveBan(
            env,
            invitedUser
          );

        if (invitedBan) {
          return json({
            ok: false,
            error:
              `${invitedUser.username} ist derzeit vom Chat ausgeschlossen.`
          }, 403);
        }

        invitedUsers.push(
          invitedUser
        );
      }

      const now =
        Math.floor(Date.now() / 1000);

      const roomResult =
        await env.DB.prepare(`
          INSERT INTO whisper_rooms (
            created_by,
            name,
            created_at
          )
          VALUES (?, ?, ?)
        `)
          .bind(
            user.id,
            name || null,
            now
          )
          .run();

      const roomId =
        roomResult.meta.last_row_id;

      /*
       * Nur Ersteller wird sofort Mitglied.
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
       * Alle anderen erhalten nur eine Einladung.
       */
      for (const invitedUser of invitedUsers) {
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
            invitedUser.id,
            now
          )
          .run();
      }

      return json({
        ok: true,

        room: {
          id: roomId,
          name: name || null,
          server: user.server,
          created_at: now,

          default_language:
            user.server ===
            "Deutschland 1"
              ? "de"
              : "en",

          members: [
            {
              id: user.id,
              username: user.username,
              server: user.server,
              role: user.role,
              is_admin:
                isAdmin(user)
            }
          ],

          pending_invites:
            invitedUsers.map(
              invitedUser => ({
                id:
                  invitedUser.id,

                username:
                  invitedUser.username
              })
            )
        },

        message:
          "Whisper-Chat wurde erstellt. Die Spieler müssen die Einladung noch annehmen."
      }, 201);
    }

    /*
     * =============================================
     * SEND
     * =============================================
     */
    if (action === "send") {
      const roomId =
        Number(body.room_id);

      if (
        !Number.isInteger(roomId) ||
        roomId <= 0
      ) {
        return json({
          ok: false,
          error:
            "Ungültiger Whisper-Raum."
        }, 400);
      }

      const member =
        await isRoomMember(
          env,
          roomId,
          user.id
        );

      if (!member) {
        return json({
          ok: false,
          error:
            "Du bist kein Mitglied dieses Whisper-Chats."
        }, 403);
      }

      const room =
        await getRoom(
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

      const members =
        await getRoomMembers(
          env,
          roomId
        );

      /*
       * Raum muss vollständig serverrein sein.
       */
      for (const roomMember of members) {
        if (
          roomMember.server !==
          user.server
        ) {
          return json({
            ok: false,
            error:
              "Dieser Whisper-Chat enthält eine ungültige Serverkombination."
          }, 403);
        }

        if (
          roomMember.id !==
          user.id
        ) {
          const blocked =
            await hasBlockBetween(
              env,
              user.id,
              roomMember.id
            );

          if (blocked) {
            return json({
              ok: false,
              error:
                `Eine Nachricht an ${roomMember.username} ist wegen einer Blockierung nicht möglich.`
            }, 403);
          }
        }
      }

      const originalMessage =
        normalizeText(
          body.message
        );

      if (!originalMessage) {
        return json({
          ok: false,
          error:
            "Die Nachricht darf nicht leer sein."
        }, 400);
      }

      if (
        originalMessage.length >
        MAX_MESSAGE_LENGTH
      ) {
        return json({
          ok: false,
          error:
            `Die Nachricht darf maximal ${MAX_MESSAGE_LENGTH} Zeichen enthalten.`
        }, 400);
      }

      const now =
        Math.floor(Date.now() / 1000);

      /*
       * Maximal 5 Whisper-Nachrichten
       * innerhalb von 10 Sekunden.
       */
      const flood =
        await env.DB.prepare(`
          SELECT COUNT(*) AS total
          FROM whisper_messages
          WHERE user_id = ?
            AND created_at >= ?
            AND deleted_at IS NULL
        `)
          .bind(
            user.id,
            now - 10
          )
          .first();

      if (
        Number(
          flood?.total || 0
        ) >= 5
      ) {
        return json({
          ok: false,
          error:
            "Du schreibst zu schnell. Bitte warte einen Moment."
        }, 429);
      }

      /*
       * Direktes Duplikat verhindern.
       *
       * Vergleich erfolgt mit original_message,
       * damit Filterung die Prüfung nicht verfälscht.
       */
      const previous =
        await env.DB.prepare(`
          SELECT original_message
          FROM whisper_messages
          WHERE room_id = ?
            AND user_id = ?
            AND deleted_at IS NULL
          ORDER BY
            created_at DESC,
            id DESC
          LIMIT 1
        `)
          .bind(
            roomId,
            user.id
          )
          .first();

      if (
        previous?.original_message &&
        previous.original_message
          .trim()
          .toLowerCase() ===
        originalMessage
          .trim()
          .toLowerCase()
      ) {
        return json({
          ok: false,
          error:
            "Bitte sende nicht mehrfach dieselbe Nachricht."
        }, 429);
      }

      let replyTo = null;

      if (
        body.reply_to !== null &&
        body.reply_to !== undefined &&
        body.reply_to !== ""
      ) {
        replyTo =
          Number(body.reply_to);

        if (
          !Number.isInteger(replyTo) ||
          replyTo <= 0
        ) {
          return json({
            ok: false,
            error:
              "Ungültige Antwort-Nachricht."
          }, 400);
        }

        const replyMessage =
          await env.DB.prepare(`
            SELECT id
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
              "Die Nachricht, auf die du antworten möchtest, existiert nicht."
          }, 404);
        }
      }

      /*
       * Sichtbarer Text wird gefiltert.
       * Exakter Text bleibt intern erhalten.
       */
      const censoredMessage =
        censorMessage(
          originalMessage
        );

      const result =
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
        `)
          .bind(
            roomId,
            user.id,
            censoredMessage,
            originalMessage,
            replyTo,
            now
          )
          .run();

      return json({
        ok: true,

        message: {
          id:
            result.meta.last_row_id,

          room_id:
            roomId,

          user: {
            id:
              user.id,

            username:
              user.username,

            server:
              user.server,

            role:
              user.role,

            is_admin:
              isAdmin(user)
          },

          message:
            censoredMessage,

          /*
           * Absender ist selbst Mitglied dieses
           * privaten Raums.
           */
          original_message:
            originalMessage,

          reply_to:
            replyTo,

          created_at:
            now
        }
      }, 201);
    }

    /*
     * =============================================
     * INVITE
     * =============================================
     */
    if (action === "invite") {
      const roomId =
        Number(body.room_id);

      const targetUserId =
        Number(body.user_id);

      if (
        !Number.isInteger(roomId) ||
        roomId <= 0 ||
        !Number.isInteger(targetUserId) ||
        targetUserId <= 0
      ) {
        return json({
          ok: false,
          error:
            "Ungültige Anfrage."
        }, 400);
      }

      const member =
        await isRoomMember(
          env,
          roomId,
          user.id
        );

      if (!member) {
        return json({
          ok: false,
          error:
            "Du bist kein Mitglied dieses Whisper-Chats."
        }, 403);
      }

      if (
        targetUserId ===
        user.id
      ) {
        return json({
          ok: false,
          error:
            "Du bist bereits Mitglied."
        }, 400);
      }

      const target =
        await getUserById(
          env,
          targetUserId
        );

      if (!target) {
        return json({
          ok: false,
          error:
            "Spieler wurde nicht gefunden."
        }, 404);
      }

      if (
        target.server !==
        user.server
      ) {
        return json({
          ok: false,
          error:
            "Du kannst nur Spieler deines eigenen Servers einladen."
        }, 403);
      }

      const targetBan =
        await getActiveBan(
          env,
          target
        );

      if (targetBan) {
        return json({
          ok: false,
          error:
            "Dieser Spieler ist derzeit vom Chat ausgeschlossen."
        }, 403);
      }

      const blocked =
        await hasBlockBetween(
          env,
          user.id,
          target.id
        );

      if (blocked) {
        return json({
          ok: false,
          error:
            "Zwischen euch besteht eine Blockierung."
        }, 403);
      }

      const alreadyMember =
        await isRoomMember(
          env,
          roomId,
          target.id
        );

      if (alreadyMember) {
        return json({
          ok: false,
          error:
            "Dieser Spieler ist bereits Mitglied."
        }, 409);
      }

      const existingInvite =
        await env.DB.prepare(`
          SELECT id
          FROM whisper_invites
          WHERE room_id = ?
            AND invited_user_id = ?
            AND status = 'pending'
          LIMIT 1
        `)
          .bind(
            roomId,
            target.id
          )
          .first();

      if (existingInvite) {
        return json({
          ok: false,
          error:
            "Dieser Spieler wurde bereits eingeladen."
        }, 409);
      }

      const members =
        await getRoomMembers(
          env,
          roomId
        );

      /*
       * Auch hier prüfen wir den gesamten Raum.
       */
      for (const roomMember of members) {
        if (
          roomMember.server !==
          user.server
        ) {
          return json({
            ok: false,
            error:
              "Dieser Whisper-Chat enthält eine ungültige Serverkombination."
          }, 403);
        }

        if (
          roomMember.id !==
          target.id
        ) {
          const memberBlocked =
            await hasBlockBetween(
              env,
              target.id,
              roomMember.id
            );

          if (memberBlocked) {
            return json({
              ok: false,
              error:
                `Eine Einladung ist wegen einer Blockierung mit ${roomMember.username} nicht möglich.`
            }, 403);
          }
        }
      }

      const pendingCount =
        await getPendingInviteCount(
          env,
          roomId
        );

      if (
        members.length +
        pendingCount >=
        MAX_ROOM_MEMBERS
      ) {
        return json({
          ok: false,
          error:
            "Dieser Whisper-Chat hat bereits die maximale Größe von 5 Spielern erreicht."
        }, 409);
      }

      const now =
        Math.floor(Date.now() / 1000);

      const result =
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

      return json({
        ok: true,

        invite: {
          id:
            result.meta.last_row_id,

          room_id:
            roomId,

          invited_user: {
            id:
              target.id,

            username:
              target.username,

            server:
              target.server,

            role:
              target.role,

            is_admin:
              isAdmin(target)
          },

          status:
            "pending",

          created_at:
            now
        },

        message:
          `${target.username} wurde eingeladen.`
      }, 201);
    }

    return json({
      ok: false,
      error:
        "Ungültige Whisper-Aktion."
    }, 400);

  } catch (error) {
    console.error(
      "POST /api/chat/whispers error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Whisper-Aktion konnte nicht ausgeführt werden."
    }, 500);
  }
}

/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * Einladung annehmen / ablehnen.
 */
export async function onRequestPut(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(request, env);

    if (!user) {
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    const banCheck =
      await ensureNotBanned(
        env,
        user
      );

    if (!banCheck.ok) {
      return banCheck.response;
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
      Number(body.invite_id);

    const response =
      typeof body.response === "string"
        ? body.response
            .trim()
            .toLowerCase()
        : "";

    if (
      !Number.isInteger(inviteId) ||
      inviteId <= 0
    ) {
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
          "Antwort muss accepted oder declined sein."
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

          inviter.username
            AS inviter_username,

          inviter.server
            AS inviter_server,

          inviter.role
            AS inviter_role

        FROM whisper_invites wi

        JOIN users inviter
          ON inviter.id =
            wi.inviter_id

        WHERE wi.id = ?

        LIMIT 1
      `)
        .bind(inviteId)
        .first();

    if (!invite) {
      return json({
        ok: false,
        error:
          "Einladung wurde nicht gefunden."
      }, 404);
    }

    if (
      invite.invited_user_id !==
      user.id
    ) {
      return json({
        ok: false,
        error:
          "Diese Einladung gehört nicht dir."
      }, 403);
    }

    if (
      invite.status !==
      "pending"
    ) {
      return json({
        ok: false,
        error:
          "Diese Einladung wurde bereits bearbeitet."
      }, 409);
    }

    /*
     * Ablehnen bleibt jederzeit möglich.
     */
    if (
      response ===
      "declined"
    ) {
      await env.DB.prepare(`
        UPDATE whisper_invites
        SET status = 'declined'
        WHERE id = ?
      `)
        .bind(inviteId)
        .run();

      return json({
        ok: true,
        status:
          "declined",

        message:
          "Einladung wurde abgelehnt."
      });
    }

    /*
     * =============================================
     * ACCEPT
     * =============================================
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
          "Whisper-Chat wurde nicht gefunden."
      }, 404);
    }

    /*
     * Einladender und Eingeladener müssen
     * weiterhin auf demselben Server sein.
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

    const inviter =
      await getUserById(
        env,
        invite.inviter_id
      );

    if (!inviter) {
      return json({
        ok: false,
        error:
          "Der einladende Spieler existiert nicht mehr."
      }, 404);
    }

    const inviterBan =
      await getActiveBan(
        env,
        inviter
      );

    if (inviterBan) {
      return json({
        ok: false,
        error:
          "Der einladende Spieler ist derzeit vom Chat ausgeschlossen."
      }, 403);
    }

    const inviterBlocked =
      await hasBlockBetween(
        env,
        user.id,
        invite.inviter_id
      );

    if (inviterBlocked) {
      return json({
        ok: false,
        error:
          "Die Einladung kann wegen einer Blockierung nicht angenommen werden."
      }, 403);
    }

    const members =
      await getRoomMembers(
        env,
        invite.room_id
      );

    if (
      members.length >=
      MAX_ROOM_MEMBERS
    ) {
      return json({
        ok: false,
        error:
          "Der Whisper-Chat ist bereits voll."
      }, 409);
    }

    /*
     * Der neue Spieler muss mit ALLEN vorhandenen
     * Mitgliedern kompatibel sein.
     */
    for (const member of members) {
      if (
        member.server !==
        user.server
      ) {
        return json({
          ok: false,
          error:
            "Dieser Whisper-Chat enthält eine ungültige Serverkombination."
        }, 403);
      }

      if (
        member.id !==
        user.id
      ) {
        const blocked =
          await hasBlockBetween(
            env,
            user.id,
            member.id
          );

        if (blocked) {
          return json({
            ok: false,
            error:
              `Du kannst diesem Whisper-Chat wegen einer Blockierung mit ${member.username} nicht beitreten.`
          }, 403);
        }
      }
    }

    const alreadyMember =
      await isRoomMember(
        env,
        invite.room_id,
        user.id
      );

    if (!alreadyMember) {
      const now =
        Math.floor(Date.now() / 1000);

      await env.DB.prepare(`
        INSERT INTO whisper_members (
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
    }

    await env.DB.prepare(`
      UPDATE whisper_invites
      SET status = 'accepted'
      WHERE id = ?
    `)
      .bind(inviteId)
      .run();

    return json({
      ok: true,

      status:
        "accepted",

      room_id:
        invite.room_id,

      message:
        "Du bist dem Whisper-Chat beigetreten."
    });

  } catch (error) {
    console.error(
      "PUT /api/chat/whispers error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Einladung konnte nicht bearbeitet werden."
    }, 500);
  }
}

/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * Aktuell bewusst deaktiviert.
 *
 * Mitglieder können sich nicht gegenseitig entfernen.
 * Admin bekommt ebenfalls keinen Sonderzugriff auf
 * private Whisper-Räume.
 *
 * Einen sauberen "Whisper verlassen"-Mechanismus
 * können wir später separat ergänzen.
 */
export async function onRequestDelete() {
  return json({
    ok: false,
    error:
      "Diese Whisper-Aktion wird derzeit nicht unterstützt."
  }, 405);
}

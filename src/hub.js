// "רכזת" לכל מסך — מחזיקה חיבור פתוח (WebSocket) עם הדף של המסך, ובהמשך גם עם התוכנה במחשב.
// כשמשהו משתנה בדף הניהול / ב-CRM, השרת שולח לרכזת הודעה, והיא דוחפת אותה מיד לכל מי שמחובר.
//
// משתמשת ב-Hibernation: כשאין הודעות, הרכזת "ישנה" והחיבורים נשארים פתוחים בלי עלות.
// ה-ping כל 30 שניות נענה אוטומטית ("pong") בלי להעיר אותה — ולפי זה יודעים מי באמת מחובר.
import { DurableObject } from 'cloudflare:workers';

const ALIVE_MS = 75 * 1000;   // חיבור בלי ping יותר מזה — נחשב מנותק

export class ScreenHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);

    // חיבור חדש: /ws?id=<מזהה המסך>&role=page|agent
    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const role = url.searchParams.get('role') === 'agent' ? 'agent' : 'page';
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, [role]);
      server.serializeAttachment({ role, screenId: url.searchParams.get('id'), at: Date.now(), info: null });
      server.send(JSON.stringify({ t: 'hello', version: this.version() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // הודעה לכל המחוברים (או רק לתפקיד מסוים): POST /notify?role=agent
    if (url.pathname === '/notify' && request.method === 'POST') {
      const msg = await request.text();
      const role = url.searchParams.get('role');
      let sent = 0;
      for (const ws of role ? this.ctx.getWebSockets(role) : this.ctx.getWebSockets()) {
        try { ws.send(msg); sent++; } catch { /* החיבור נסגר */ }
      }
      return Response.json({ ok: true, sent });
    }

    // מי מחובר עכשיו
    if (url.pathname === '/status') {
      const now = Date.now();
      const clients = [];
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() || {};
        const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws);
        const last = Math.max(a.at || 0, pong ? pong.getTime() : 0);
        if (now - last > ALIVE_MS) continue;
        clients.push({ role: a.role, since: new Date(a.at).toISOString(), last: new Date(last).toISOString(), info: a.info });
      }
      return Response.json({ ok: true, clients });
    }

    return new Response('Not found', { status: 404 });
  }

  version() {
    return (this.env.CF_VERSION_METADATA && this.env.CF_VERSION_METADATA.id) || 'dev';
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 2000) return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (m.t === 'info') {
      // המסך מספר על עצמו: רזולוציה, גרסה
      const a = ws.deserializeAttachment() || {};
      a.info = { w: Number(m.w) || null, h: Number(m.h) || null, v: String(m.v || '').slice(0, 60),
        app: String(m.app || '').slice(0, 60) || undefined };
      a.at = Date.now();
      ws.serializeAttachment(a);
      await this.touch(a.screenId, a.info);
    }
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment() || {};
    await this.touch(a.screenId, null);
  }

  async webSocketError(ws) {
    const a = ws.deserializeAttachment() || {};
    await this.touch(a.screenId, null);
  }

  // "נראה לאחרונה" במסד הנתונים — כדי שגם אחרי ניתוק יודעים מתי המסך היה מחובר
  async touch(screenId, info) {
    if (!screenId || !this.env.DB) return;
    try {
      if (info) {
        await this.env.DB.prepare('UPDATE screens SET seen_at = ?, seen_info = ? WHERE id = ?')
          .bind(new Date().toISOString(), JSON.stringify(info), screenId).run();
      } else {
        await this.env.DB.prepare('UPDATE screens SET seen_at = ? WHERE id = ?')
          .bind(new Date().toISOString(), screenId).run();
      }
    } catch (err) {
      console.error(JSON.stringify({ message: 'hub touch failed', error: String(err) }));
    }
  }
}

/**
 * Frenos para los envíos del dueño: WhatsApp castiga ráfagas desde dispositivos no
 * oficiales, así que limitamos por minuto, hora y día, y dejamos aire entre mensajes
 * al mismo chat. Devuelve el motivo si hay que esperar.
 */
export const SEND_LIMITS = { perMinute: 8, perHour: 40, perDay: 150, sameChatGapMs: 3_000 };

export class SendLimiter {
  private sent: { at: number; chat: string }[] = [];

  constructor(private readonly limits = SEND_LIMITS) {}

  private prune(now: number): void {
    const dayAgo = now - 86_400_000;
    this.sent = this.sent.filter((s) => s.at > dayAgo);
  }

  /** null si se puede enviar; si no, el motivo */
  check(chat: string, now = Date.now()): string | null {
    this.prune(now);
    const since = (ms: number) => this.sent.filter((s) => s.at > now - ms).length;
    if (since(60_000) >= this.limits.perMinute)
      return `Límite de ${this.limits.perMinute} mensajes por minuto: espera un momento`;
    if (since(3_600_000) >= this.limits.perHour)
      return `Límite de ${this.limits.perHour} mensajes por hora alcanzado`;
    if (this.sent.length >= this.limits.perDay)
      return `Límite de ${this.limits.perDay} mensajes por día alcanzado`;
    const last = this.sent.filter((s) => s.chat === chat).at(-1);
    if (last && now - last.at < this.limits.sameChatGapMs)
      return 'Espera unos segundos antes de volver a escribir a este chat';
    return null;
  }

  record(chat: string, now = Date.now()): void {
    this.sent.push({ at: now, chat });
  }

  remaining(now = Date.now()): { hour: number; day: number } {
    this.prune(now);
    const hour = this.sent.filter((s) => s.at > now - 3_600_000).length;
    return {
      hour: Math.max(0, this.limits.perHour - hour),
      day: Math.max(0, this.limits.perDay - this.sent.length),
    };
  }
}

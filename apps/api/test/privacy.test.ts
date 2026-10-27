import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '../src/session/message-vault.js';
import type { DirectoryPerson } from '../src/session/stats.js';
import { buildItems } from '../src/ventaplay/plan.js';
import {
  buildPrivacyRows,
  classify,
  emptySettings,
  included,
  parseSettings,
} from '../src/ventaplay/privacy.js';

let n = 0;
const msg = (text: string, fromMe = false, ts = 1_700_000_000_000 + n): StoredMessage => ({
  id: `m${++n}`,
  fromMe,
  ts,
  kind: 'text',
  text,
  sender: null,
  pushName: null,
  media: null,
});

const person = (
  phone: string,
  saved: string | null,
  extra: Partial<DirectoryPerson> = {},
): DirectoryPerson => ({
  jid: `${phone}@s.whatsapp.net`,
  phone,
  lid: null,
  displayName: saved ?? 'Sin agenda',
  savedName: saved,
  pushName: 'Push',
  businessName: null,
  inAddressBook: saved !== null,
  messages: 0,
  firstMessageAt: null,
  lastMessageAt: null,
  ...extra,
});

describe('filtro de privacidad: clasificación', () => {
  it('nombre de agenda familiar → privado, aunque hable de horas', () => {
    const c = classify(person('56911111111', 'Mamá ❤️'), [msg('quiero agendar una hora')]);
    expect(c.category).toBe('privado');
    expect(c.reasons[0]).toContain('Mamá');
  });

  it('pide hora, precio y servicio → comercial, con el motivo', () => {
    const c = classify(person('56922222222', null), [
      msg('Hola doctora, quería consultar el valor del botox'),
      msg('Tenemos hora el jueves, le esperamos', true),
    ]);
    expect(c.category).toBe('comercial');
    expect(c.reasons.join(' ')).toMatch(/botox|le esperamos/);
  });

  it('trato cercano sin negocio → privado', () => {
    const c = classify(person('56933333333', 'Caro'), [
      msg('te amo, mi amor'),
      msg('que duermas bien', true),
    ]);
    expect(c.category).toBe('privado');
  });

  it('sin señales o sin mensajes → revisar', () => {
    expect(classify(person('56944444444', 'Pedro'), [msg('ok'), msg('dale')]).category).toBe(
      'revisar',
    );
    expect(classify(person('56955555555', 'Juan'), []).category).toBe('revisar');
  });

  it('el nombre del negocio en los mensajes suma a comercial', () => {
    const c = classify(
      person('56966666666', null),
      [msg('Gracias por escribir a Clínica Demo', true)],
      {
        businessName: 'Clínica Demo',
      },
    );
    expect(c.reasons.join(' ')).toContain('Clínica Demo');
  });

  it('el pushName (cómo se llama a sí mismo) no cuenta como nombre de agenda', () => {
    const p = person('56977777777', null, { pushName: 'Tía Carmen', displayName: 'Tía Carmen' });
    expect(classify(p, [msg('precio del pack de depilación?')]).category).toBe('comercial');
  });
});

describe('filtro de privacidad: decisiones y lista', () => {
  it('lo decidido a mano pisa la sugerencia; revisar no entra por defecto', () => {
    expect(included('comercial', null, false)).toBe(true);
    expect(included('privado', null, false)).toBe(false);
    expect(included('revisar', null, false)).toBe(false);
    expect(included('revisar', null, true)).toBe(true);
    expect(included('comercial', 'excluir', false)).toBe(false);
    expect(included('privado', 'incluir', false)).toBe(true);
  });

  it('ajustes dañados o con basura vuelven a lo vacío', () => {
    expect(parseSettings('{no json')).toEqual(emptySettings());
    const s = parseSettings(
      JSON.stringify({ active: true, decisions: { '569': 'x', '561': 'incluir' } }),
    );
    expect(s.active).toBe(true);
    expect(s.decisions).toEqual({ '561': 'incluir' });
  });

  it('una fila por contacto con número; último mensaje con texto; sin el propio número', () => {
    const rows = buildPrivacyRows(
      {
        sessionPhone: '56900000000',
        businessName: 'Clínica Demo',
        directory: {
          people: [
            person('56911111111', 'Mamá'),
            person('56922222222', null),
            person('56900000000', 'Yo'),
            { ...person('1', null), phone: null, jid: '1@lid', lid: '1@lid' },
          ],
          groups: [],
        },
        chats: [
          {
            jid: '56922222222@s.whatsapp.net',
            messages: [
              msg('valor de la limpieza facial?', false, 10),
              msg('le esperamos', true, 20),
            ],
          },
          { jid: '120@g.us', messages: [msg('grupo', false, 30)] },
        ],
      },
      { ...emptySettings(), decisions: { '56911111111': 'incluir' } },
    );
    expect(rows.map((r) => r.phone)).toEqual(['56922222222', '56911111111']);
    expect(rows[0]).toMatchObject({
      suggestion: 'comercial',
      include: true,
      lastText: 'le esperamos',
      lastFromMe: true,
      messages: 2,
    });
    expect(rows[1]).toMatchObject({ suggestion: 'privado', decision: 'incluir', include: true });
  });

  it('buildItems deja fuera a los excluidos (cliente y mensajes) y los cuenta', () => {
    const items = buildItems(
      {
        sessionPhone: '56900000000',
        sessionName: 'Clínica',
        directory: {
          people: [person('56911111111', 'Mamá'), person('56922222222', 'Ana')],
          groups: [],
        },
        chats: [
          { jid: '56911111111@s.whatsapp.net', messages: [msg('hola hija'), msg('hola', true)] },
          { jid: '56922222222@s.whatsapp.net', messages: [msg('precio?')] },
        ],
      },
      null,
      new Set(['56911111111']),
    );
    expect(items.clients.map((c) => c.telefono)).toEqual(['56922222222']);
    expect(items.messages).toHaveLength(1);
    expect(items.privados).toEqual({ clientes: 1, mensajes: 2 });
    expect(items.mensajesFuera).toBe(0);
    // sin filtro: privados null
    expect(
      buildItems(
        { sessionPhone: '5', sessionName: null, directory: { people: [], groups: [] }, chats: [] },
        null,
      ).privados,
    ).toBeNull();
  });
});

describe('filtro de privacidad: casos de conversaciones largas', () => {
  it('apellido de quien autorizó → revisar; trato íntimo repetido → privado; muy larga → revisar', () => {
    const ctx = { ownerName: 'Doctora Ana Rivas Soto' };
    const fam = classify(person('56910000001', 'pía rivas'), [msg('precio del botox')], ctx);
    expect(fam.category).toBe('revisar');
    expect(fam.reasons[0]).toContain('rivas');

    const intimo = Array.from({ length: 5 }, () => msg('te amo mami'));
    expect(classify(person('56910000002', 'Maca'), [...intimo, msg('botox')], ctx).category).toBe(
      'privado',
    );

    const dos = [msg('te quiero'), msg('te quiero'), msg('valor del botox y la limpieza facial')];
    const c2 = classify(person('56910000003', 'Sandra'), dos, ctx);
    expect(c2.category).toBe('revisar');

    const larga = Array.from({ length: 800 }, () => msg('agendar botox'));
    expect(classify(person('56910000004', 'Karina'), larga, ctx).category).toBe('revisar');
    // guardada como paciente gana
    expect(classify(person('56910000005', 'Karina Pac'), larga, ctx).category).toBe('comercial');
  });
});

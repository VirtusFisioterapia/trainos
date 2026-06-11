const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

async function main() {
  // Range settimana scorsa (lunedì → domenica)
  const oggi = new Date();
  const giornoDellaSett = oggi.getDay(); // 0=dom, 1=lun...
  const lunedi = new Date(oggi);
  lunedi.setDate(oggi.getDate() - ((giornoDellaSett + 6) % 7) - 7);
  lunedi.setHours(0, 0, 0, 0);
  const domenica = new Date(lunedi);
  domenica.setDate(lunedi.getDate() + 6);
  domenica.setHours(23, 59, 59, 999);

  const dataInizio = lunedi.toISOString().split('T')[0];
  const dataFine = domenica.toISOString().split('T')[0];

  const settLabel = `${lunedi.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })} – ${domenica.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  // Recupera sessioni pianificate nella settimana
  const { data: sessioni } = await sb
    .from('sessioni')
    .select('*')
    .eq('is_template', false)
    .gte('data', dataInizio)
    .lte('data', dataFine);

  if (!sessioni || sessioni.length === 0) {
    console.log('Nessuna sessione nella settimana, skip.');
    return;
  }

  // Recupera risultati per le sessioni trovate
  const sessioneIds = sessioni.map(s => s.id);
  const { data: risultati } = await sb
    .from('risultati')
    .select('*')
    .in('sessione_id', sessioneIds)
    .eq('completato', true);

  // Recupera profili atleti
  const { data: profiles } = await sb
    .from('profiles')
    .select('email, nome, gruppo')
    .eq('ruolo', 'atleta');

  const profileMap = {};
  (profiles || []).forEach(p => { profileMap[p.email] = p; });

  // ── Costruisci struttura dati ──
  // { atleta_email → { blocco → { esercizio → { pianTot, esegTot, isIso } } } }
  const struttura = {};

  sessioni.forEach(s => {
    const email = s.atleta_email;
    const blocco = s.blocco || 'Senza blocco';
    const eserc = s.esercizio;
    const isIso = (blocco || '').toLowerCase().includes('isometria');

    if (!struttura[email]) struttura[email] = {};
    if (!struttura[email][blocco]) struttura[email][blocco] = {};
    if (!struttura[email][blocco][eserc]) {
      struttura[email][blocco][eserc] = { pianTot: 0, esegTot: 0, isIso };
    }

    const r = struttura[email][blocco][eserc];

    if (isIso) {
      r.pianTot += (s.rip_piano || 0) * (s.tut_piano || 0);
      const ris = (risultati || []).find(r2 => r2.sessione_id === s.id);
      if (ris) r.esegTot += (ris.rip_eseguito || 0) * (ris.tut_eseguito || 0);
    } else {
      r.pianTot += (s.kg_piano || 0) * (s.rip_piano || 0);
      const ris = (risultati || []).find(r2 => r2.sessione_id === s.id);
      if (ris) r.esegTot += (ris.kg_eseguito || 0) * (ris.rip_eseguito || 0);
    }
  });

  // ── Costruisci intestazioni colonne (blocco → [esercizi]) ──
  // Raccoglie tutti i blocchi e i relativi esercizi in ordine
  const blocchiEsercizi = {}; // { blocco → Set(esercizi) }
  Object.values(struttura).forEach(blocchi => {
    Object.entries(blocchi).forEach(([blocco, esercizi]) => {
      if (!blocchiEsercizi[blocco]) blocchiEsercizi[blocco] = new Set();
      Object.keys(esercizi).forEach(e => blocchiEsercizi[blocco].add(e));
    });
  });

  const blocchiOrdinati = Object.keys(blocchiEsercizi).sort();

  // ── Genera HTML tabella ──
  const percColor = (p) => {
    if (p === null) return '#999';
    if (p >= 95) return '#16a34a';
    if (p >= 75) return '#f97316';
    return '#dc2626';
  };

  // Riga header blocchi (spanning)
  let headerBlocchi = '<th style="background:#f4f5f7;padding:10px 14px;text-align:left;font-family:monospace;font-size:12px;border:1px solid #000;min-width:160px">Atleta</th>';
  blocchiOrdinati.forEach(blocco => {
    const esercizi = [...blocchiEsercizi[blocco]];
    headerBlocchi += `<th colspan="${esercizi.length}" style="background:#142ecb;color:#fff;padding:10px 14px;text-align:center;font-size:13px;font-weight:700;border:1px solid #000;letter-spacing:1px">${blocco}</th>`;
  });

  // Riga header esercizi
  let headerEsercizi = '<th style="border:1px solid #000"></th>';
  blocchiOrdinati.forEach(blocco => {
    const esercizi = [...blocchiEsercizi[blocco]];
    const isIso = blocco.toLowerCase().includes('isometria');
    esercizi.forEach(e => {
      headerEsercizi += `<th style="background:#f4f5f7;padding:8px 12px;text-align:center;font-size:12px;border:1px solid #000;white-space:nowrap">${e}<br><span style="color:#666;font-size:10px">${isIso ? 'TUT %' : 'Tonn. %'}</span></th>`;
    });
  });

  // Righe atleti
  const atleti = Object.keys(struttura).sort((a, b) => {
    const nA = profileMap[a]?.nome || a;
    const nB = profileMap[b]?.nome || b;
    return nA.localeCompare(nB);
  });

  let righeAtleti = '';
  atleti.forEach((email, idx) => {
    const p = profileMap[email];
    const nome = p?.nome || email;
    const squadra = p?.gruppo || '';
    const rowBg = idx % 2 === 0 ? '#ffffff' : '#f9f9f9';

    let celle = `<td style="background:${rowBg};padding:10px 14px;font-weight:700;font-size:14px;border:1px solid #000;white-space:nowrap">
      ${nome}<br><span style="font-size:11px;color:#666;font-weight:400">${squadra}</span>
    </td>`;

    blocchiOrdinati.forEach(blocco => {
      const esercizi = [...blocchiEsercizi[blocco]];
      esercizi.forEach(eserc => {
        const dati = struttura[email]?.[blocco]?.[eserc];
        if (!dati) {
          celle += `<td style="background:${rowBg};padding:10px 14px;text-align:center;border:1px solid #000;color:#999;font-size:13px">—</td>`;
        } else {
          const perc = dati.pianTot > 0 ? Math.round(dati.esegTot / dati.pianTot * 100) : null;
          const color = percColor(perc);
          celle += `<td style="background:${rowBg};padding:10px 14px;text-align:center;border:1px solid #000;font-size:14px;font-weight:700;color:${color}">${perc !== null ? perc + '%' : '—'}</td>`;
        }
      });
    });

    righeAtleti += `<tr>${celle}</tr>`;
  });

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:'DM Sans',Arial,sans-serif;background:#f4f5f7;padding:32px;margin:0">
  <div style="max-width:900px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:2px solid #000">
    
    <!-- Header -->
    <div style="background:#fe6d0d;padding:24px 32px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-family:'Bebas Neue',Arial,sans-serif;font-size:36px;color:#fff;letter-spacing:4px">VIRTUS</div>
        <div style="color:rgba(255,255,255,0.85);font-size:13px;letter-spacing:2px;text-transform:uppercase;font-family:monospace">Resoconto Settimanale</div>
      </div>
      <div style="color:#fff;font-size:14px;text-align:right;font-family:monospace">
        ${settLabel}
      </div>
    </div>

    <!-- Tabella -->
    <div style="padding:24px 32px;overflow-x:auto">
      <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif">
        <thead>
          <tr>${headerBlocchi}</tr>
          <tr>${headerEsercizi}</tr>
        </thead>
        <tbody>
          ${righeAtleti}
        </tbody>
      </table>
    </div>

    <!-- Legenda -->
    <div style="padding:16px 32px;border-top:1px solid #000;display:flex;gap:24px;flex-wrap:wrap">
      <span style="font-size:12px;color:#333">Legenda:</span>
      <span style="font-size:12px"><span style="color:#16a34a;font-weight:700">≥95%</span> Obiettivo raggiunto</span>
      <span style="font-size:12px"><span style="color:#f97316;font-weight:700">75–94%</span> Parziale</span>
      <span style="font-size:12px"><span style="color:#dc2626;font-weight:700">&lt;75%</span> Sotto obiettivo</span>
      <span style="font-size:12px"><span style="color:#999">—</span> Non pianificato</span>
    </div>

    <!-- Footer -->
    <div style="padding:16px 32px;background:#f4f5f7;text-align:center">
      <span style="font-size:12px;color:#666;font-family:monospace">VIRTUS · Virtus Fisioterapia e Performance · generato automaticamente ogni domenica</span>
    </div>
  </div>
</body>
</html>`;

  await resend.emails.send({
    from: 'VIRTUS <onboarding@resend.dev>',
    to: 'info@virtusfisio.it',
    subject: `VIRTUS — Resoconto settimana ${settLabel}`,
    html,
  });

  console.log(`✅ Resoconto inviato per la settimana ${settLabel}`);
}

main().catch(console.error);

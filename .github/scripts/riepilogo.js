const { Resend } = require('resend');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const resend = new Resend(process.env.RESEND_API_KEY);

async function query(table, params = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  return res.json();
}

async function main() {
  const oggi = new Date();
  const giornoDellaSett = oggi.getDay();
  const lunedi = new Date(oggi);
  lunedi.setDate(oggi.getDate() - ((giornoDellaSett + 6) % 7) - 7);
  lunedi.setHours(0, 0, 0, 0);
  const domenica = new Date(lunedi);
  domenica.setDate(lunedi.getDate() + 6);

  const dataInizio = lunedi.toISOString().split('T')[0];
  const dataFine = domenica.toISOString().split('T')[0];
  const settLabel = `${lunedi.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })} – ${domenica.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  const sessioni = await query('sessioni', `is_template=eq.false&data=gte.${dataInizio}&data=lte.${dataFine}&select=*`);
  if (!sessioni || sessioni.length === 0) {
    console.log('Nessuna sessione nella settimana, skip.');
    return;
  }

  const sessioneIds = sessioni.map(s => s.id).join(',');
  const risultati = await query('risultati', `sessione_id=in.(${sessioneIds})&completato=eq.true&select=*`);
  const profiles = await query('profiles', `ruolo=eq.atleta&select=email,nome,gruppo`);

  const profileMap = {};
  (profiles || []).forEach(p => { profileMap[p.email] = p; });

  const struttura = {};
  sessioni.forEach(s => {
    const email = s.atleta_email;
    const blocco = s.blocco || 'Senza blocco';
    const eserc = s.esercizio;
    const isIso = (blocco || '').toLowerCase().includes('isometria');

    if (!struttura[email]) struttura[email] = {};
    if (!struttura[email][blocco]) struttura[email][blocco] = {};
    if (!struttura[email][blocco][eserc]) struttura[email][blocco][eserc] = { pianTot: 0, esegTot: 0, isIso };

    const r = struttura[email][blocco][eserc];
    const ris = (risultati || []).find(r2 => r2.sessione_id === s.id);

    if (isIso) {
      r.pianTot += (s.rip_piano || 0) * (s.tut_piano || 0);
      if (ris) r.esegTot += (ris.rip_eseguito || 0) * (ris.tut_eseguito || 0);
    } else {
      r.pianTot += (s.kg_piano || 0) * (s.rip_piano || 0);
      if (ris) r.esegTot += (ris.kg_eseguito || 0) * (ris.rip_eseguito || 0);
    }
  });

  const blocchiEsercizi = {};
  Object.values(struttura).forEach(blocchi => {
    Object.entries(blocchi).forEach(([blocco, esercizi]) => {
      if (!blocchiEsercizi[blocco]) blocchiEsercizi[blocco] = new Set();
      Object.keys(esercizi).forEach(e => blocchiEsercizi[blocco].add(e));
    });
  });
  const blocchiOrdinati = Object.keys(blocchiEsercizi).sort();

  const percColor = (p) => p === null ? '#999' : p >= 95 ? '#16a34a' : p >= 75 ? '#f97316' : '#dc2626';

  let headerBlocchi = '<th style="background:#f4f5f7;padding:10px 14px;text-align:left;font-size:12px;border:1px solid #000;min-width:160px">Atleta</th>';
  blocchiOrdinati.forEach(blocco => {
    const n = [...blocchiEsercizi[blocco]].length;
    headerBlocchi += `<th colspan="${n}" style="background:#142ecb;color:#fff;padding:10px 14px;text-align:center;font-size:13px;font-weight:700;border:1px solid #000">${blocco}</th>`;
  });

  let headerEsercizi = '<th style="border:1px solid #000;background:#f4f5f7"></th>';
  blocchiOrdinati.forEach(blocco => {
    const isIso = blocco.toLowerCase().includes('isometria');
    [...blocchiEsercizi[blocco]].forEach(e => {
      headerEsercizi += `<th style="background:#f4f5f7;padding:8px 12px;text-align:center;font-size:12px;border:1px solid #000;white-space:nowrap">${e}<br><span style="color:#666;font-size:10px">${isIso ? 'TUT %' : 'Tonn. %'}</span></th>`;
    });
  });

  const atleti = Object.keys(struttura).sort((a, b) => (profileMap[a]?.nome || a).localeCompare(profileMap[b]?.nome || b));
  let righeAtleti = '';
  atleti.forEach((email, idx) => {
    const p = profileMap[email];
    const nome = p?.nome || email;
    const squadra = p?.gruppo || '';
    const rowBg = idx % 2 === 0 ? '#ffffff' : '#f9f9f9';

    let celle = `<td style="background:${rowBg};padding:10px 14px;font-weight:700;font-size:14px;border:1px solid #000;white-space:nowrap">${nome}<br><span style="font-size:11px;color:#666;font-weight:400">${squadra}</span></td>`;

    blocchiOrdinati.forEach(blocco => {
      [...blocchiEsercizi[blocco]].forEach(eserc => {
        const dati = struttura[email]?.[blocco]?.[eserc];
        if (!dati) {
          celle += `<td style="background:${rowBg};padding:10px 14px;text-align:center;border:1px solid #000;color:#999;font-size:13px">—</td>`;
        } else {
          const perc = dati.pianTot > 0 ? Math.round(dati.esegTot / dati.pianTot * 100) : null;
          celle += `<td style="background:${rowBg};padding:10px 14px;text-align:center;border:1px solid #000;font-size:14px;font-weight:700;color:${percColor(perc)}">${perc !== null ? perc + '%' : '—'}</td>`;
        }
      });
    });

    righeAtleti += `<tr>${celle}</tr>`;
  });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;background:#f4f5f7;padding:32px;margin:0">
  <div style="max-width:900px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:2px solid #000">
    <div style="background:#fe6d0d;padding:24px 32px">
      <div style="font-size:36px;color:#fff;letter-spacing:4px;font-weight:900">VIRTUS</div>
      <div style="color:rgba(255,255,255,0.85);font-size:13px;letter-spacing:2px;text-transform:uppercase">Riepilogo Settimanale · ${settLabel}</div>
    </div>
    <div style="padding:24px 32px;overflow-x:auto">
      <table style="border-collapse:collapse;width:100%">
        <thead><tr>${headerBlocchi}</tr><tr>${headerEsercizi}</tr></thead>
        <tbody>${righeAtleti}</tbody>
      </table>
    </div>
    <div style="padding:16px 32px;border-top:1px solid #000;display:flex;gap:24px;flex-wrap:wrap">
      <span style="font-size:12px;color:#333">Legenda:</span>
      <span style="font-size:12px"><span style="color:#16a34a;font-weight:700">≥95%</span> Obiettivo raggiunto</span>
      <span style="font-size:12px"><span style="color:#f97316;font-weight:700">75–94%</span> Parziale</span>
      <span style="font-size:12px"><span style="color:#dc2626;font-weight:700">&lt;75%</span> Sotto obiettivo</span>
      <span style="font-size:12px"><span style="color:#999">—</span> Non pianificato</span>
    </div>
    <div style="padding:16px 32px;background:#f4f5f7;text-align:center">
      <span style="font-size:12px;color:#666">VIRTUS · Virtus Fisioterapia e Performance · generato automaticamente ogni domenica</span>
    </div>
  </div>
</body></html>`;

  await resend.emails.send({
    from: 'VIRTUS <onboarding@resend.dev>',
    to: 'info@virtusfisio.it',
    subject: `VIRTUS — Riepilogo settimana ${settLabel}`,
    html,
  });

  console.log(`✅ Riepilogo inviato per la settimana ${settLabel}`);
}

main().catch(console.error);

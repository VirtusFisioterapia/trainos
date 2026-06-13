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
  // Carica tutti i risultati: sia quelli principali (completato=true) che i per-rep (rep_idx not null)
  const risultati = await query('risultati', `sessione_id=in.(${sessioneIds})&select=*`);
  const profiles = await query('profiles', `ruolo=eq.atleta&select=email,nome,cognome,gruppo`);

  const profileMap = {};
  (profiles || []).forEach(p => { profileMap[p.email] = p; });

  // Raggruppa per squadra → atleta → blocco → esercizio
  // Per ogni esercizio distinguiamo: normale, iso pushing, iso holding
  const strutturaGlobale = {};

  sessioni.forEach(s => {
    const email = s.atleta_email;
    const p = profileMap[email];
    const squadra = p?.gruppo || 'Senza squadra';
    const blocco = s.blocco || 'Senza blocco';
    const eserc = s.esercizio;
    const bloccoLower = (blocco || '').toLowerCase();
    const isIso = bloccoLower.includes('isometria');
    const isHolding = bloccoLower.includes('holding');
    const isPushing = isIso && !isHolding;

    if (!strutturaGlobale[squadra]) strutturaGlobale[squadra] = {};
    if (!strutturaGlobale[squadra][email]) strutturaGlobale[squadra][email] = {};
    if (!strutturaGlobale[squadra][email][blocco]) strutturaGlobale[squadra][email][blocco] = {};
    if (!strutturaGlobale[squadra][email][blocco][eserc]) {
      strutturaGlobale[squadra][email][blocco][eserc] = {
        isIso, isHolding, isPushing,
        pianTot: 0, esegTot: 0,   // per normale e pushing
        serie: []                  // per holding: array di { piano: {rip, tut, kg}, reps: [{kg, tut}] }
      };
    }

    const d = strutturaGlobale[squadra][email][blocco][eserc];
    // Risultato principale (completato=true, rep_idx=null)
    const ris = (risultati || []).find(r => r.sessione_id === s.id && r.completato === true && r.rep_idx == null);
    // Record per-rep (rep_idx not null) — solo holding
    const repRecords = isHolding
      ? (risultati || []).filter(r => r.sessione_id === s.id && r.rep_idx != null).sort((a, b) => a.rep_idx - b.rep_idx)
      : [];

    if (isHolding) {
      // Per holding: accumula serie con dettaglio rep
      const reps = repRecords.map(r => ({
        kg: r.kg_rep,
        tut: r.tut_eseguito
      }));
      d.serie.push({
        piano: { rip: s.rip_piano || 0, tut: s.tut_piano || 0, kg: s.kg_piano },
        reps
      });
    } else if (isPushing) {
      d.pianTot += (s.rip_piano || 0) * (s.tut_piano || 0);
      if (ris) d.esegTot += (ris.rip_eseguito || 0) * (ris.tut_eseguito || 0);
    } else {
      d.pianTot += (s.kg_piano || 0) * (s.rip_piano || 0);
      if (ris) d.esegTot += (ris.kg_eseguito || 0) * (ris.rip_eseguito || 0);
    }
  });

  const percColor = (p) => p === null ? '#999' : p >= 95 ? '#16a34a' : p >= 75 ? '#f97316' : '#dc2626';

  // Genera cella per holding: mostra rep per rep kg × tut
  function cellaHolding(dati, rowBg) {
    if (!dati || dati.serie.length === 0) {
      return `<td style="background:${rowBg};padding:10px 14px;text-align:center;border:1px solid #000;color:#999;font-size:12px">—</td>`;
    }
    let righe = '';
    dati.serie.forEach((serie, si) => {
      if (serie.reps.length === 0) {
        righe += `<div style="font-size:11px;color:#999">S${si+1}: non eseguita</div>`;
      } else {
        const repStr = serie.reps.map((r, ri) => {
          const kg = r.kg != null ? r.kg + 'kg' : '—';
          const tut = r.tut != null ? r.tut + 's' : '—';
          const tutOk = r.tut != null && serie.piano.tut > 0;
          const color = tutOk ? (r.tut > serie.piano.tut ? '#16a34a' : r.tut === serie.piano.tut ? '#16a34a' : r.tut > 0 ? '#f97316' : '#dc2626') : '#999';
          const bold = tutOk && r.tut > serie.piano.tut ? 'font-weight:700;' : '';
          return `<span style="color:${color};${bold}white-space:nowrap">R${ri+1}:${kg}×${tut}</span>`;
        }).join(' ');
        righe += `<div style="font-size:11px;margin-bottom:2px"><span style="color:#666">S${si+1}</span> ${repStr}</div>`;
      }
    });
    return `<td style="background:${rowBg};padding:8px 12px;border:1px solid #000;font-size:12px;min-width:140px">${righe}</td>`;
  }

  // Genera HTML per sezioni squadre
  let sezioniHtml = '';
  const squadreOrdinate = Object.keys(strutturaGlobale).sort();

  squadreOrdinate.forEach(squadra => {
    const struttura = strutturaGlobale[squadra];

    // Raccogli blocchi e esercizi
    const blocchiEsercizi = {};
    Object.values(struttura).forEach(blocchi => {
      Object.entries(blocchi).forEach(([blocco, esercizi]) => {
        if (!blocchiEsercizi[blocco]) blocchiEsercizi[blocco] = new Set();
        Object.keys(esercizi).forEach(e => blocchiEsercizi[blocco].add(e));
      });
    });
    const blocchiOrdinati = Object.keys(blocchiEsercizi).sort();

    // Header riga 1: blocchi
    let headerBlocchi = '<th style="background:#f4f5f7;padding:10px 14px;text-align:left;font-size:12px;border:1px solid #000;min-width:160px">Atleta</th>';
    blocchiOrdinati.forEach(blocco => {
      const n = [...blocchiEsercizi[blocco]].length;
      headerBlocchi += `<th colspan="${n}" style="background:#142ecb;color:#fff;padding:10px 14px;text-align:center;font-size:13px;font-weight:700;border:1px solid #000">${blocco}</th>`;
    });

    // Header riga 2: esercizi con etichetta tipo
    let headerEsercizi = '<th style="border:1px solid #000;background:#f4f5f7"></th>';
    blocchiOrdinati.forEach(blocco => {
      const bloccoLower = blocco.toLowerCase();
      const isHolding = bloccoLower.includes('holding');
      const isPushing = bloccoLower.includes('isometria') && !isHolding;
      [...blocchiEsercizi[blocco]].forEach(e => {
        const etichetta = isHolding ? 'kg × TUT per rep' : isPushing ? 'TUT %' : 'Tonn. %';
        headerEsercizi += `<th style="background:#f4f5f7;padding:8px 12px;text-align:center;font-size:12px;border:1px solid #000;white-space:nowrap">${e}<br><span style="color:#666;font-size:10px">${etichetta}</span></th>`;
      });
    });

    // Righe atleti
    const atleti = Object.keys(struttura).sort((a, b) => {
      const nA = profileMap[a] ? `${profileMap[a].nome||''} ${profileMap[a].cognome||''}`.trim() : a;
      const nB = profileMap[b] ? `${profileMap[b].nome||''} ${profileMap[b].cognome||''}`.trim() : b;
      return nA.localeCompare(nB);
    });

    let righeAtleti = '';
    atleti.forEach((email, idx) => {
      const p = profileMap[email];
      const nome = p ? `${p.nome||''} ${p.cognome||''}`.trim() || email : email;
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#f9f9f9';

      let celle = `<td style="background:${rowBg};padding:10px 14px;font-weight:700;font-size:14px;border:1px solid #000;white-space:nowrap">${nome}</td>`;

      blocchiOrdinati.forEach(blocco => {
        const bloccoLower = blocco.toLowerCase();
        const isHolding = bloccoLower.includes('holding');
        [...blocchiEsercizi[blocco]].forEach(eserc => {
          const dati = struttura[email]?.[blocco]?.[eserc];
          if (isHolding) {
            celle += cellaHolding(dati, rowBg);
          } else if (!dati) {
            celle += `<td style="background:${rowBg};padding:10px 14px;text-align:center;border:1px solid #000;color:#999;font-size:13px">—</td>`;
          } else {
            const perc = dati.pianTot > 0 ? Math.round(dati.esegTot / dati.pianTot * 100) : null;
            celle += `<td style="background:${rowBg};padding:10px 14px;text-align:center;border:1px solid #000;font-size:14px;font-weight:700;color:${percColor(perc)}">${perc !== null ? perc + '%' : '—'}</td>`;
          }
        });
      });

      righeAtleti += `<tr>${celle}</tr>`;
    });

    sezioniHtml += `
      <div style="margin-bottom:32px">
        <div style="background:#111;color:#fff;padding:12px 20px;font-size:16px;font-weight:700;letter-spacing:2px;text-transform:uppercase;border-radius:8px 8px 0 0">${squadra}</div>
        <div style="overflow-x:auto">
          <table style="border-collapse:collapse;width:100%">
            <thead><tr>${headerBlocchi}</tr><tr>${headerEsercizi}</tr></thead>
            <tbody>${righeAtleti}</tbody>
          </table>
        </div>
      </div>`;
  });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;background:#f4f5f7;padding:32px;margin:0">
  <div style="max-width:960px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:2px solid #000">
    <div style="background:#fe6d0d;padding:24px 32px">
      <div style="font-size:36px;color:#fff;letter-spacing:4px;font-weight:900">VIRTUS</div>
      <div style="color:rgba(255,255,255,0.85);font-size:13px;letter-spacing:2px;text-transform:uppercase">Riepilogo Settimanale · ${settLabel}</div>
    </div>
    <div style="padding:24px 32px;overflow-x:auto">
      ${sezioniHtml}
    </div>
    <div style="padding:16px 32px;border-top:1px solid #000;display:flex;gap:24px;flex-wrap:wrap">
      <span style="font-size:12px;color:#333">Legenda:</span>
      <span style="font-size:12px"><span style="color:#16a34a;font-weight:700">≥95%</span> Obiettivo raggiunto</span>
      <span style="font-size:12px"><span style="color:#f97316;font-weight:700">75–94%</span> Parziale</span>
      <span style="font-size:12px"><span style="color:#dc2626;font-weight:700">&lt;75%</span> Sotto obiettivo</span>
      <span style="font-size:12px"><span style="color:#999">—</span> Non pianificato / non eseguito</span>
      <span style="font-size:12px"><span style="color:#dc2626;font-weight:700">0s</span> Rep interrotta subito</span>
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

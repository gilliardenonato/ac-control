import { useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import type { Dashboard, Device } from "./api.ts";
import { BarChart, LineChart, Legend } from "./Charts.tsx";
import type { BarItem } from "./Charts.tsx";
import { brl, dm, kwhN, MONTH, num1, pctDelta, WEEKDAY, wdayOf } from "./fmt.ts";
import { Alert, Kpi, Segmented } from "./ui.tsx";

interface Pt { key: string; wh: number; final?: boolean; costBrl: number | null }
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const sum = (a: number[]) => a.reduce((s, n) => s + n, 0);
const daysInMonth = (m: string) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
const prevMonth = (m: string) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

export function Energy({ device, tick }: { device: Device; tick: number }) {
  const [range, setRange] = useState<30 | 60 | 90>(30);
  const [days, setDays] = useState<Pt[]>([]);
  const [months, setMonths] = useState<Pt[]>([]);
  const [status, setStatus] = useState<{ supported: boolean | null; lastError: string | null; needsScope: boolean } | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const today = new Intl.DateTimeFormat("en-CA").format(Date.now());
  useEffect(() => {
    void api.get<{ points: Pt[]; status: any }>(`/devices/${device.id}/energy?granularity=day&from=${addDays(today, -119)}&to=${today}`).then((r) => { setDays(r.points); setStatus(r.status); });
    void api.get<{ points: Pt[] }>(`/devices/${device.id}/energy?granularity=month&from=${prevMonth(prevMonth(prevMonth(prevMonth(prevMonth(prevMonth(prevMonth(prevMonth(prevMonth(prevMonth(prevMonth(prevMonth(today.slice(0, 7)))))))))))))}`).then((r) => setMonths(r.points));
    void api.get<Dashboard>(`/devices/${device.id}/dashboard`).then(setDash);
  }, [device.id, today, tick]);

  const byDate = useMemo(() => new Map(days.map((d) => [d.key, d])), [days]);
  const closed = useMemo(() => days.filter((d) => d.key < today), [days, today]);
  const month = today.slice(0, 7), pm = prevMonth(month), dayOfMonth = +today.slice(8);
  const todayPt = byDate.get(today);

  // KPIs
  const yKey = addDays(today, -1), yPt = byDate.get(yKey);
  const avg30 = closed.slice(-30).length ? sum(closed.slice(-30).map((d) => d.wh)) / closed.slice(-30).length : 0;
  const last7 = closed.filter((d) => d.key >= addDays(today, -7)), prev7 = closed.filter((d) => d.key >= addDays(today, -14) && d.key < addDays(today, -7));
  const mtdClosed = closed.filter((d) => d.key.startsWith(month)), prevSame = closed.filter((d) => d.key.startsWith(pm) && +d.key.slice(8) <= dayOfMonth - 1);
  const mtdAll = days.filter((d) => d.key.startsWith(month));
  const monthWh = sum(mtdAll.map((d) => d.wh)), monthCost = mtdAll.every((d) => d.costBrl !== null) && mtdAll.length ? sum(mtdAll.map((d) => d.costBrl!)) : null;
  const lastMonthPt = months.find((m) => m.key === pm);
  const yearAgo = `${+month.slice(0, 4) - 1}${month.slice(4)}`;
  const yearAgoPt = months.find((m) => m.key === yearAgo);
  const p = dash?.projection;
  const goal = p?.goalBrl ?? null;
  const goalStatus = goal !== null && p?.projectedCostBrl != null ? (p.projectedCostBrl > goal ? "crit" : (monthCost ?? 0) > goal * 0.9 ? "warn" : "ok") : undefined;

  // gráfico diário
  const shown = days.slice(-range);
  const shownClosed = shown.filter((d) => d.key < today);
  const avg = shownClosed.length ? sum(shownClosed.map((d) => d.wh)) / shownClosed.length : 0;
  const items: BarItem[] = shown.map((d) => ({
    key: d.key, x: dm(d.key), value: d.wh / 1000, partial: d.key === today,
    tip: { title: `${WEEKDAY[wdayOf(d.key)]}, ${dm(d.key)}${d.key === today ? " (parcial)" : ""}`, rows: [["Consumo", `${kwhN(d.wh, 2)} kWh`], ["Custo", d.costBrl === null ? "—" : brl(d.costBrl)], ...(avg > 0 && d.key !== today ? [["vs média", `${d.wh >= avg ? "+" : "−"}${Math.abs(((d.wh - avg) / avg) * 100).toFixed(0)}%`] as [string, string]] : [])] },
  }));
  const maxDay = shownClosed.reduce<Pt | null>((b, d) => (!b || d.wh > b.wh ? d : b), null), minDay = shownClosed.reduce<Pt | null>((b, d) => (!b || d.wh < b.wh ? d : b), null);
  const totalWh = sum(shownClosed.map((d) => d.wh)), totalCost = shownClosed.length && shownClosed.every((d) => d.costBrl !== null) ? sum(shownClosed.map((d) => d.costBrl!)) : null;

  // por dia da semana
  const wd = Array.from({ length: 7 }, (_, i) => { const v = shownClosed.filter((d) => wdayOf(d.key) === i); return { i, n: v.length, avg: v.length ? sum(v.map((d) => d.wh)) / v.length : 0 }; });
  const wdItems: BarItem[] = [1, 2, 3, 4, 5, 6, 0].map((i) => ({ key: String(i), x: WEEKDAY[i]!, value: wd[i]!.avg / 1000, tip: { title: `${WEEKDAY[i]} (média)`, rows: [["Consumo médio", `${kwhN(wd[i]!.avg, 2)} kWh`], ["Amostras", `${wd[i]!.n} dias`]] } }));

  // acumulado do mês vs anterior (+ projeção tracejada)
  const cum = (m: string, until: number) => { let s = 0; return Array.from({ length: until }, (_, i) => { const d = byDate.get(`${m}-${String(i + 1).padStart(2, "0")}`); s += d ? d.wh / 1000 : 0; return { x: i + 1, y: s }; }); };
  const dim = daysInMonth(month);
  const curCum = cum(month, dayOfMonth), prevCum = cum(pm, daysInMonth(pm));
  const projCum = useMemo(() => {
    const a = mtdClosed.length ? sum(mtdClosed.map((d) => d.wh)) / mtdClosed.length / 1000 : 0;
    const last = curCum.at(-1);
    return last && a > 0 ? Array.from({ length: dim - dayOfMonth + 1 }, (_, i) => ({ x: dayOfMonth + i, y: last.y + a * i })) : [];
  }, [curCum.length, mtdClosed.length, dim, dayOfMonth]);  // eslint-disable-line react-hooks/exhaustive-deps
  const monthItems: BarItem[] = months.map((m) => ({ key: m.key, x: `${MONTH[+m.key.slice(5) - 1]}/${m.key.slice(2, 4)}`, value: m.wh / 1000, partial: m.key === month,
    tip: { title: `${MONTH[+m.key.slice(5) - 1]} de ${m.key.slice(0, 4)}${m.key === month ? " (até agora)" : ""}`, rows: [["Consumo", `${kwhN(m.wh, 1)} kWh`], ["Custo", m.costBrl === null ? "sem tarifa" : brl(m.costBrl)]] } }));

  return (
    <>
      <div className="pagehead"><h1>Energia</h1><span className="sub">Consumo informado pelo aparelho via LG, em kWh. Datas no seu fuso.</span></div>
      {status?.supported === false && <div className="alerts"><Alert kind="info">Este aparelho não informa consumo pela API da LG; nada é inventado aqui.</Alert></div>}
      {status?.needsScope && <div className="alerts"><Alert kind="warn">{status.lastError}</Alert></div>}

      <div className="g12">
        <div className="c2"><Kpi label="Hoje" basis="measured" value={kwhN(todayPt?.wh, 2)} unit="kWh" detail={`${todayPt?.costBrl != null ? brl(todayPt.costBrl) : "—"} · parcial`} /></div>
        <div className="c2"><Kpi label="Ontem" basis="measured" value={kwhN(yPt?.wh, 2)} unit="kWh" delta={yPt && avg30 ? pctDelta(yPt.wh, avg30, "vs média 30 d") : null} detail={yPt?.costBrl != null ? brl(yPt.costBrl) : undefined} /></div>
        <div className="c2"><Kpi label="Últimos 7 dias" basis="measured" value={kwhN(sum(last7.map((d) => d.wh)), 1)} unit="kWh" delta={prev7.length === 7 && last7.length ? pctDelta(sum(last7.map((d) => d.wh)), sum(prev7.map((d) => d.wh)), "vs 7 anteriores") : null} detail={last7.every((d) => d.costBrl !== null) && last7.length ? brl(sum(last7.map((d) => d.costBrl!))) : undefined} /></div>
        <div className="c2"><Kpi label="Mês até agora" basis="measured" value={kwhN(monthWh, 1)} unit="kWh" delta={prevSame.length && mtdClosed.length ? pctDelta(sum(mtdClosed.map((d) => d.wh)), sum(prevSame.map((d) => d.wh)), "vs mês anterior") : null} detail={monthCost !== null ? brl(monthCost) : undefined} /></div>
        <div className="c2"><Kpi label="Projeção do mês" basis={p?.projectedCostBrl != null ? "estimated" : null} status={goalStatus} value={p?.projectedWh != null ? kwhN(p.projectedWh, 0) : "—"} unit="kWh" detail={p?.projectedCostBrl != null ? `${brl(p.projectedCostBrl)}${goal !== null ? ` · meta ${brl(goal)}` : ""}` : "precisa de dias fechados"} /></div>
        <div className="c2"><Kpi label="Mês anterior" basis="measured" value={kwhN(lastMonthPt?.wh, 1)} unit="kWh" delta={lastMonthPt && yearAgoPt ? null : null} detail={[lastMonthPt?.costBrl != null ? brl(lastMonthPt.costBrl) : null, yearAgoPt ? `mesmo mês em ${yearAgo.slice(0, 4)}: ${kwhN(yearAgoPt.wh, 0)} kWh` : null].filter(Boolean).join(" · ") || undefined} /></div>

        <section className="card c8" aria-label="Consumo por dia">
          <header>
            <div><h3>Consumo por dia</h3><p>kWh por dia nos últimos {range} dias. A linha tracejada é a média dos dias fechados ({num1(avg / 1000, 1)} kWh). Passe o mouse para ver o custo.</p></div>
            <Segmented label="Período" value={String(range) as "30" | "60" | "90"} options={[{ value: "30", label: "30 dias" }, { value: "60", label: "60 dias" }, { value: "90", label: "90 dias" }]} onChange={(v) => setRange(+v as 30 | 60 | 90)} />
          </header>
          {items.length ? <BarChart items={items} yFormat={(v) => num1(v, v % 1 ? 1 : 0)} avg={{ value: avg / 1000, label: `média ${num1(avg / 1000, 1)}` }} height={420} ariaLabel="Consumo diário de energia em kWh" /> : <p className="muted small">Sem dados de energia no período.</p>}
          <div className="legend" style={{ marginTop: "auto" }}><span><i style={{ background: "var(--chart-a)" }} />dia fechado</span><span><i style={{ background: "var(--chart-c)" }} />hoje (parcial)</span></div>
        </section>

        <section className="card c4" aria-label="Resumo do período">
          <header><div><h3>Resumo dos {range} dias</h3><p>Só dias fechados ({shownClosed.length}).</p></div></header>
          <dl className="facts">
            <div><dt>Total</dt><dd>{kwhN(totalWh, 1)} kWh<small>{totalCost !== null ? brl(totalCost) : "sem tarifa em parte do período"}</small></dd></div>
            <div><dt>Média por dia</dt><dd>{kwhN(avg, 1)} kWh<small>{totalCost !== null && shownClosed.length ? `${brl(totalCost / shownClosed.length)} por dia` : ""}</small></dd></div>
            <div><dt>Maior dia</dt><dd>{maxDay ? `${kwhN(maxDay.wh, 1)} kWh` : "—"}<small>{maxDay ? `${WEEKDAY[wdayOf(maxDay.key)]}, ${dm(maxDay.key)}` : ""}</small></dd></div>
            <div><dt>Menor dia</dt><dd>{minDay ? `${kwhN(minDay.wh, 1)} kWh` : "—"}<small>{minDay ? `${WEEKDAY[wdayOf(minDay.key)]}, ${dm(minDay.key)}` : ""}</small></dd></div>
          </dl>
          <div><div className="label" style={{ marginBottom: ".25rem" }}>Média por dia da semana (kWh)</div><BarChart items={wdItems} height={150} yFormat={(v) => num1(v, v % 1 ? 1 : 0)} ariaLabel="Consumo médio por dia da semana" /></div>
          <p className="muted small" style={{ margin: 0 }}>Descreve o histórico observado; clima e uso não são controlados, então não indica causa.</p>
        </section>

        <section className="card c6" aria-label="Acumulado do mês">
          <header><div><h3>Acumulado do mês</h3><p>kWh somados dia a dia, comparado com o mês anterior. A linha tracejada projeta o resto do mês pela média.</p></div></header>
          <Legend items={[{ name: MONTH[+month.slice(5) - 1]! + " (atual)", cls: "a" }, { name: MONTH[+pm.slice(5) - 1]! + " (anterior)", cls: "b" }, { name: "projeção", cls: "a", dashed: true }]} />
          <LineChart ariaLabel="Consumo acumulado no mês comparado ao mês anterior" height={280} xDomain={[1, 31]} xTicks={[1, 5, 10, 15, 20, 25, 30]} xFormat={(x) => String(x)} yFormat={(v) => num1(v, v % 1 ? 1 : 0)}
            series={[{ id: "prev", name: "anterior", cls: "b", points: prevCum }, ...(projCum.length ? [{ id: "proj", name: "projeção", cls: "a" as const, dashed: true, points: projCum }] : []), { id: "cur", name: "atual", cls: "a", points: curCum, area: true }]}
            tip={(x, vals) => ({ title: `Dia ${x}`, rows: vals.filter((v) => v.y !== null).map((v) => [v.s.id === "cur" ? "Este mês" : v.s.id === "prev" ? "Mês anterior" : "Projeção", `${num1(v.y!, 1)} kWh`] as [string, string]) })} />
        </section>

        <section className="card c6" aria-label="Consumo por mês">
          <header><div><h3>Consumo por mês</h3><p>kWh nos últimos 12 meses; o mês atual (laranja) ainda está em andamento.</p></div></header>
          {monthItems.length ? <BarChart items={monthItems} height={280} yFormat={(v) => num1(v, 0)} ariaLabel="Consumo mensal de energia em kWh" avg={months.length > 2 ? { value: sum(months.filter((m) => m.key !== month).map((m) => m.wh)) / Math.max(1, months.filter((m) => m.key !== month).length) / 1000, label: "média" } : undefined} /> : <p className="muted small">Sem dados mensais.</p>}
        </section>
      </div>
    </>
  );
}

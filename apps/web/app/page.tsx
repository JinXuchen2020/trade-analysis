'use client';

import { useEffect, useState, useMemo } from 'react';
import { importData, findTrades } from '@/lib/services/dataService';
import type { Trade, Position } from '@/lib/services/dataService';
import { computeFifo } from '@/lib/fifo';
import { DashboardMetrics } from '@/modules/DashboardMetrics';
import { PositionsTable } from '@/modules/PositionsTable';
import { TradesTable } from '@/modules/TradesTable';
import { SymbolTags } from '@/modules/SymbolTags';
import AddTradeModal from '@/components/AddTradeModal';
import Link from 'next/link';
import { calcMetrics } from '@/lib/metrics';
import { useStore } from '@/lib/store';
import { fetchRealtimeQuote, fetchDailyClose } from '@/lib/services/priceService';

export default function DashboardPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    async function loadData() {
      try {
        setIsLoading(true);
        const response = await fetch('/trades.json');
        if (!response.ok) {
          throw new Error('Failed to fetch trades.json');
        }
        const rawData = await response.json();
        await importData(rawData);

        const dbTrades = await findTrades();
        const enriched = computeFifo(dbTrades);

        // 根据 enriched 计算最新持仓（quantityAfter / averageCost）
        const lastMap: Record<string, any> = {};
        for (const t of enriched) {
          lastMap[t.symbol] = t; // 由于 computeFifo 已按日期升序，遍历结束时即为最后状态
        }

        const posList: Position[] = Object.values(lastMap)
          .filter(t => t.quantityAfter !== 0) // 只保留有持仓的
          .map(t => ({
            symbol: t.symbol,
            qty: t.quantityAfter,
            avgPrice: t.averageCost,
            last: t.averageCost, // 初始值
            priceOk: true,
          }));

        // 为每个持仓获取最新价格
        for (const pos of posList) {
          try {
            let result = await fetchRealtimeQuote(pos.symbol);
            if (!result || result.price === 1) {
              const today = new Date().toISOString().slice(0, 10);
              result = await fetchDailyClose(pos.symbol, today);
            }

            if (result && result.price && result.price !== 1) {
              pos.last = result.price;
              pos.priceOk = !result.stale;
            } else {
              pos.last = NaN;
              pos.priceOk = false;
            }
          } catch (e) {
            pos.last = NaN;
            pos.priceOk = false;
          }
        }

        if (posList.some(p => !p.priceOk)) {
          setError('无法获取实时价格，指标计算失败');
          setIsLoading(false);
          return;
        }

        console.log('加载的持仓数据:', posList);
        console.log('持仓数据中的qty类型:', posList.map(p => ({
          symbol: p.symbol,
          qty: p.qty,
          qtyType: typeof p.qty,
          isNumber: !isNaN(Number(p.qty))
        })));

        // 获取每日结果数据用于计算周期性指标
        const dailyResultsResponse = await fetch('/dailyResult.json');
        const dailyResults = dailyResultsResponse.ok ? await dailyResultsResponse.json() : [];

        // 计算指标并存入全局状态
        const metrics = calcMetrics(enriched, posList, dailyResults);
        useStore.getState().setMetrics(metrics);

        setTrades(dbTrades);
        setPositions(posList);
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : 'An unknown error occurred.');
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, []);

  const enrichedTrades = useMemo(() => {
    if (trades.length > 0) {
      return computeFifo(trades);
    }
    return [];
  }, [trades]);

  // Unique set of all traded symbols
  const symbolsInTrades = useMemo(() => {
    const set = new Set(trades.map(t => t.symbol));
    return Array.from(set);
  }, [trades]);

  async function reloadData() {
    try {
      const dbTrades = await findTrades();
      const enriched = computeFifo(dbTrades);

      // 根据 enriched 计算最新持仓
      const lastMap: Record<string, any> = {};
      for (const t of enriched) {
        lastMap[t.symbol] = t;
      }

      const posList: Position[] = Object.values(lastMap)
        .filter(t => t.quantityAfter !== 0)
        .map(t => ({
          symbol: t.symbol,
          qty: t.quantityAfter,
          avgPrice: t.averageCost,
          last: t.averageCost, // 初始值
          priceOk: true,
        }));

      for (const pos of posList) {
        try {
          let result = await fetchRealtimeQuote(pos.symbol);
          if (!result || result.price === 1) {
            const today = new Date().toISOString().slice(0, 10);
            result = await fetchDailyClose(pos.symbol, today);
          }
          if (result && result.price && result.price !== 1) {
            pos.last = result.price;
            pos.priceOk = !result.stale;
          } else {
            pos.last = NaN;
            pos.priceOk = false;
          }
        } catch (e) {
          pos.last = NaN;
          pos.priceOk = false;
        }
      }

      if (posList.some(p => !p.priceOk)) {
        setError('无法获取实时价格，指标计算失败');
        return;
      }

      // 获取每日结果数据用于计算周期性指标
      const dailyResultsResponse = await fetch('/dailyResult.json');
      const dailyResults = dailyResultsResponse.ok ? await dailyResultsResponse.json() : [];

      // 计算指标并更新全局状态
      const metrics = calcMetrics(enriched, posList, dailyResults);
      useStore.getState().setMetrics(metrics);

      setTrades(dbTrades);
      setPositions(posList);
    } catch (e) { console.error(e); }
  }

  if (isLoading) {
    return <div className="text-center p-10">Loading Dashboard...</div>;
  }

  if (error) {
    return <div className="text-center p-10 text-destructive">Error: {error}</div>;
  }

  return (
    <div>
      <DashboardMetrics enrichedTrades={enrichedTrades} positions={positions} />

      <h3 className="section-title" id="positions-title">目前持仓 <Link href="/analysis" className="details">交易分析</Link></h3>
      <PositionsTable positions={positions} trades={enrichedTrades} />

      <h3 className="section-title">个股情况 <Link href="/" className="details" style={{ visibility: 'hidden' }}>详情</Link></h3>
      <SymbolTags symbols={symbolsInTrades} />

      <h3 className="section-title">交易记录 <Link href="/trades" className="details">查看全部</Link></h3>
      <TradesTable trades={enrichedTrades} />

      <button
        id="fab"
        onClick={() => setShowModal(true)}
      >
        +
      </button>
      {showModal && <AddTradeModal onClose={() => setShowModal(false)} onAdded={reloadData} />}
    </div>
  );
}

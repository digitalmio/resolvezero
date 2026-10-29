import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export interface QueryChartPoint {
  key: string
  time: string
  day: string
  full: string
  total: number
  blocked: number
}

/** Compact request counts for the Y axis: 950, 1.2k, 48k, 1.6M. */
function axisNumber(value: number): string {
  if (value >= 1_000_000) return `${short(value / 1_000_000)}M`
  if (value >= 1_000) return `${short(value / 1_000)}k`
  return String(Math.round(value))
}

function short(value: number): string {
  const rounded = value >= 10 ? Math.round(value) : Number(value.toFixed(1))
  return String(rounded)
}

export function QueryChart({ data }: { data: QueryChartPoint[] }) {
  return (
    <div className="mt-5 min-h-[300px] w-full flex-1" role="img" aria-label="Query volume over the last 24 hours">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="rz-query-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ink)" stopOpacity={0.1} />
              <stop offset="100%" stopColor="var(--ink)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="2 5" />
          <XAxis
            dataKey="key"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: 'var(--muted)' }}
            interval="preserveStartEnd"
            minTickGap={32}
            tickFormatter={(value: string) => {
              const point = data.find((entry) => entry.key === value)
              if (!point) return value
              return point.time === '00:00' ? point.day : point.time
            }}
          />
          <YAxis
            width={42}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: 'var(--muted)' }}
            tickFormatter={(value: number) => axisNumber(value)}
            allowDecimals={false}
            tickCount={4}
          />
          <Tooltip
            cursor={{ stroke: 'var(--line)', strokeWidth: 1 }}
            itemSorter={(item) => (item.dataKey === 'total' ? 0 : 1)}
            contentStyle={{
              background: 'var(--card)',
              border: '1px solid var(--line-strong)',
              borderRadius: 2,
              boxShadow: '0 12px 32px rgba(11,11,10,0.12)',
              fontSize: 11,
              padding: '6px 8px',
            }}
            labelStyle={{ color: 'var(--muted)', marginBottom: 2, lineHeight: 1.2 }}
            itemStyle={{ padding: 0, lineHeight: 1.3 }}
            labelFormatter={(label, payload) => {
              const point = payload?.[0]?.payload as QueryChartPoint | undefined
              return point?.full ?? label
            }}
            formatter={(value, name) => [Number(value).toLocaleString('en-GB'), name === 'total' ? 'Queries' : 'Blocked']}
          />
          <Area
            type="monotone"
            dataKey="total"
            stroke="var(--ink)"
            strokeWidth={1.8}
            fill="url(#rz-query-area)"
            dot={false}
            isAnimationActive
            animationDuration={250}
          />
          <Area
            type="monotone"
            dataKey="blocked"
            stroke="var(--accent)"
            strokeWidth={1.5}
            fill="transparent"
            dot={false}
            isAnimationActive
            animationDuration={250}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

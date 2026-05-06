interface ProgressProps {
  percent: number
}

export default function Progress({ percent }: ProgressProps) {
  return (
    <div className="flex w-full items-center text-slate-300">
      <div className="relative mr-4 h-2 flex-1 overflow-hidden rounded-full border border-white/10 bg-white/10">
        <div
          className="absolute left-0 top-0 h-full rounded-full bg-primary duration-100"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="w-20 text-right text-sm text-slate-400">
        {percent.toFixed(2)}%
      </span>
    </div>
  )
}

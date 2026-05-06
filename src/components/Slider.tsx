type SliderProps = {
  label?: any
  value?: number
  min?: number
  max?: number
  onChange: (value: number) => void
  onStart?: () => void
}

export default function Slider(props: SliderProps) {
  const { value, label, min, max, onChange, onStart } = props

  const step = ((max || 100) - (min || 0)) / 100

  return (
    <div className="inline-flex items-center space-x-4 text-sm text-slate-300">
      <span className="min-w-[72px] text-slate-400">{label}</span>
      <input
        className={[
          'h-2 w-full appearance-none rounded-full border border-white/10 bg-white/10 accent-[#2f8cff]',
          'outline-none',
        ].join(' ')}
        type="range"
        step={step}
        min={min}
        max={max}
        value={value}
        onPointerDown={onStart}
        onChange={ev => {
          ev.preventDefault()
          ev.stopPropagation()
          onChange(parseInt(ev.currentTarget.value, 10))
        }}
      />
    </div>
  )
}

import { ReactNode, useState } from 'react'

interface ButtonProps {
  children: ReactNode
  className?: string
  icon?: ReactNode
  primary?: boolean
  disabled?: boolean
  iconOnly?: boolean
  style?: {
    [key: string]: string
  }
  onClick?: () => void
  onDown?: () => void
  onUp?: () => void
  onEnter?: () => void
  onLeave?: () => void
}

export default function Button(props: ButtonProps) {
  const {
    children,
    className,
    icon,
    primary,
    disabled,
    iconOnly,
    style,
    onClick,
    onDown,
    onUp,
    onEnter,
    onLeave,
  } = props
  const [active, setActive] = useState(false)
  let background = ''
  if (disabled) {
    background =
      'border-white/8 bg-white/[0.03] text-slate-500 opacity-55 hover:border-white/8 hover:bg-white/[0.03]'
  } else if (primary) {
    background =
      'border-primary/60 bg-primary/20 text-sky-100 hover:border-primary hover:bg-primary/30'
  }
  if (active && !disabled) {
    background = 'border-primary bg-primary text-white'
  }
  if (!primary && !active && !disabled) {
    background =
      'border-white/10 bg-white/5 text-slate-100 hover:border-primary/40 hover:bg-white/10'
  }
  return (
    <div
      role="button"
      aria-disabled={disabled}
      onKeyDown={() => {
        if (disabled) {
          return
        }
        onDown?.()
      }}
      onClick={() => {
        if (disabled) {
          return
        }
        onClick?.()
      }}
      onPointerDown={() => {
        if (disabled) {
          return
        }
        setActive(true)
        onDown?.()
      }}
      onPointerUp={() => {
        if (disabled) {
          return
        }
        setActive(false)
        onUp?.()
      }}
      onPointerEnter={() => {
        if (disabled) {
          return
        }
        onEnter?.()
      }}
      onPointerLeave={() => {
        setActive(false)
        if (disabled) {
          return
        }
        onLeave?.()
      }}
      tabIndex={-1}
      className={[
        'inline-flex items-center justify-center rounded-xl border py-3',
        iconOnly ? 'h-12 w-12 px-0' : 'px-5',
        icon && !iconOnly ? 'space-x-3' : '',
        'transition duration-150 ease-out select-none',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        background,
        className,
      ].join(' ')}
      style={style}
    >
      {icon}
      <span className={iconOnly ? 'sr-only' : 'whitespace-nowrap select-none'}>
        {children}
      </span>
    </div>
  )
}

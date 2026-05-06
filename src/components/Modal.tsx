import { ReactNode } from 'react'

interface ModalProps {
  children?: ReactNode
}

export default function Modal(props: ModalProps) {
  const { children } = props
  return (
    <div
      className={[
        'absolute flex h-full w-full items-center justify-center',
        'bg-black/60 backdrop-blur-md',
      ].join(' ')}
    >
      <div className="max-w-4xl rounded-3xl border border-white/10 bg-[#161a20] p-12 text-slate-100 shadow-[0_30px_120px_rgba(0,0,0,0.55)]">
        {children}
      </div>
    </div>
  )
}

import { Check, ChevronLeft } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TEXT_SIZES, readTextSize, saveTextSize, type TextSize } from './textsize'

/** Settings -> Tampilan: how large the text is. Kept on this phone only. */
export function DisplayScreen() {
  const navigate = useNavigate()
  const [size, setSize] = useState<TextSize>(readTextSize)
  const choose = (next: TextSize) => {
    setSize(next)
    saveTextSize(next)
  }
  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-white">
      <header className="flex items-center gap-3 bg-surface px-3 py-3">
        <button type="button" aria-label="Kembali" onClick={() => navigate('/app/pengaturan')} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft">
          <ChevronLeft className="h-6 w-6" />
        </button>
        <h1 className="font-semibold">Tampilan</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-5 pt-5 pb-8">
        <h2 className="text-sm font-semibold">Ukuran teks</h2>
        <p className="mt-1 text-sm text-ink-soft">Berlaku di seluruh aplikasi ini, hanya di ponsel ini.</p>

        <div role="group" aria-label="Pratinjau" className="mt-4 flex flex-col gap-2 rounded-2xl bg-surface p-4">
          <div className="max-w-[82%] self-start whitespace-pre-line rounded-2xl rounded-bl-md bg-white px-4 py-2.5 text-[0.9375rem] text-ink">Ada 2 hal penting hari ini: revisi denah dan termin 2.</div>
          <div className="max-w-[82%] self-end rounded-2xl rounded-br-md bg-brand-500 px-4 py-2.5 text-[0.9375rem] text-white">Apa yang jatuh tempo minggu ini?</div>
        </div>

        <ul role="radiogroup" aria-label="Ukuran teks" className="mt-4">
          {TEXT_SIZES.map((item) => {
            const on = item.id === size
            return (
              <li key={item.id} className="border-b border-surface">
                <button type="button" role="radio" aria-checked={on} onClick={() => choose(item.id)} className="flex w-full items-center justify-between gap-3 py-3.5 text-left">
                  <span className="font-medium">{item.label}</span>
                  {on && <Check aria-hidden="true" className="h-5 w-5 text-brand-600" />}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

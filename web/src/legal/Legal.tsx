import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/**
 * Terms and privacy text. Both are a DRAFT until a person who knows Indonesian data protection law (UU PDP)
 * has read them: flip REVIEWED to true then, put the legal entity's full name in ENTITY if it differs from the
 * brand, and bump TERMS_VERSION in src/onboarding.ts so customers agree again.
 */
const REVIEWED = false
const ENTITY = 'Aksis AI by Flaat Studio'
const CONTACT = 'hello@example.com'
const UPDATED = '2 November 2026'

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper text-forest">
      <header className="mx-auto flex max-w-2xl items-center justify-between px-5 py-5">
        <Link to="/">
          <img src="/logo-lockup.svg" alt="Aksis AI" className="h-7 w-auto" />
        </Link>
        <nav aria-label="Dokumen" className="flex gap-4 text-sm font-medium">
          <Link to="/terms" className="hover:underline">Syarat</Link>
          <Link to="/privacy" className="hover:underline">Privasi</Link>
        </nav>
      </header>
      <main className="mx-auto max-w-2xl px-5 pb-16">
        <h1 className="text-[28px] font-medium leading-tight tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-moss">Diperbarui {UPDATED}</p>
        {!REVIEWED && (
          <p role="note" className="mt-4 rounded-xl border border-line bg-white p-4 text-sm leading-relaxed text-moss">
            Versi draf: teks ini belum ditinjau ahli hukum dan dapat berubah.
          </p>
        )}
        <div className="mt-6 flex flex-col gap-6 text-[15px] leading-relaxed">{children}</div>
      </main>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-medium">{title}</h2>
      {children}
    </section>
  )
}

const list = 'flex list-disc flex-col gap-1.5 pl-5'

export function Terms() {
  return (
    <Page title="Syarat Layanan">
      <Section title="1. Layanan">
        <p>
          Aksis AI adalah asisten untuk profesional dan studio yang bekerja dengan klien, misalnya arsitek, kontraktor, desainer, dan konsultan. Aksis membaca grup WhatsApp proyek serta chat pribadi yang Anda pilih, lalu
          merangkum keputusan, permintaan revisi, tugas, tenggat, dan tindak lanjut. Layanan dioperasikan oleh {ENTITY},
          selanjutnya &quot;kami&quot;. Dengan melanjutkan pendaftaran, Anda menyetujui syarat ini dan Kebijakan Privasi.
        </p>
      </Section>
      <Section title="2. WhatsApp tertaut dan risikonya">
        <p>
          Aksis membaca WhatsApp lewat perangkat tertaut, seperti WhatsApp Web, memakai cara yang tidak disediakan secara resmi oleh WhatsApp.
          Karena itu WhatsApp dapat sewaktu-waktu mengubah aturannya, memutus tautan, atau membatasi akun. Kami tidak dapat menjamin hal itu
          tidak terjadi dan tidak bertanggung jawab atas pembatasan akun WhatsApp Anda. Gunakan nomor yang Anda sanggup risikonya, dan Anda bisa
          mencabut tautan kapan saja dari menu Perangkat Tertaut di WhatsApp.
        </p>
      </Section>
      <Section title="3. Hasil AI bisa keliru">
        <p>
          Ringkasan dan jawaban dibuat oleh model AI dari pesan yang tersimpan. Hasilnya dapat salah, tidak lengkap, atau melewatkan hal penting.
          Setiap ringkasan menyertakan sumber chat supaya dapat diperiksa. Anda bertanggung jawab memeriksa hal penting (biaya, tenggat, keputusan
          kontrak) sebelum bertindak. Aksis tidak memberi nasihat hukum, keuangan, atau teknis.
        </p>
      </Section>
      <Section title="4. Tanggung jawab Anda">
        <ul className={list}>
          <li>Anda berhak memakai grup dan chat yang Anda pilih, dan memberi tahu klien serta anggota grup bahwa percakapan dibantu alat otomatis bila diperlukan.</li>
          <li>Anda tidak memakai Aksis untuk melanggar hukum, mengganggu orang lain, atau membebani layanan secara berlebihan.</li>
          <li>Anda menjaga akses ke ponsel dan nomor WhatsApp Anda, dan segera memberi tahu kami bila ada penyalahgunaan.</li>
        </ul>
      </Section>
      <Section title="5. Paket, uji coba, dan pembayaran">
        <p>
          Paket menentukan jumlah grup yang dapat dipantau. Uji coba berlangsung 14 hari sejak akun diaktifkan. Pembayaran saat ini lewat transfer
          bank dan dicatat oleh admin kami. Setelah langganan berakhir ada masa tenggang 3 hari, lalu layanan AI berhenti. Harga dan paket dapat
          berubah dengan pemberitahuan sebelumnya.
        </p>
      </Section>
      <Section title="6. Penghentian dan data">
        <p>
          Anda dapat berhenti kapan saja dan meminta data dihapus (lihat Kebijakan Privasi). Kami dapat menangguhkan atau menghentikan akun yang
          melanggar syarat ini. Bila langganan berakhir dan tidak diperpanjang, data dihapus otomatis sesuai jadwal di Kebijakan Privasi.
        </p>
      </Section>
      <Section title="7. Batas tanggung jawab">
        <p>
          Layanan diberikan sebagaimana adanya. Sejauh diizinkan hukum, tanggung jawab kami terbatas pada biaya yang Anda bayar untuk satu bulan
          terakhir, dan kami tidak bertanggung jawab atas kerugian tidak langsung, termasuk keputusan proyek yang diambil berdasarkan hasil AI.
        </p>
      </Section>
      <Section title="8. Perubahan dan hukum yang berlaku">
        <p>
          Kami dapat memperbarui syarat ini; perubahan penting akan diberitahukan dan, bila perlu, Anda diminta menyetujui ulang. Syarat ini tunduk
          pada hukum Republik Indonesia. Pertanyaan: {CONTACT}.
        </p>
      </Section>
    </Page>
  )
}

export function Privacy() {
  return (
    <Page title="Kebijakan Privasi">
      <Section title="1. Siapa kami">
        <p>
          Aksis AI dikelola oleh {ENTITY} (&quot;kami&quot;), yang menjadi pengendali data pribadi untuk data yang dijelaskan di sini. Kontak
          untuk urusan data pribadi: {CONTACT}.
        </p>
      </Section>
      <Section title="2. Data yang kami proses">
        <ul className={list}>
          <li>Data akun: nama studio, nama Anda, nomor WhatsApp, status langganan, dan waktu persetujuan syarat ini.</li>
          <li>Formulir permintaan akses di beranda: nama dan nomor WhatsApp yang Anda isi. Dipakai hanya untuk menghubungi Anda, dan dihapus otomatis 30 hari setelah masuk bila tidak berlanjut menjadi akun (bila berlanjut, datanya pindah ke data akun).</li>
          <li>Pesan teks dari grup dan chat pribadi yang Anda pilih (isi, waktu, nama tampilan pengirim). Gambar dan pesan suara tidak dibaca.</li>
          <li>Hasil analisis: keputusan, revisi, tugas, tenggat, dan catatan status proyek beserta rujukan ke pesan sumbernya.</li>
          <li>Percakapan Anda dengan asisten di aplikasi, dan, bila Anda mengaktifkannya, alamat notifikasi perangkat Anda.</li>
          <li>Catatan teknis dan catatan tindakan admin. Catatan ini berisi hitungan dan identitas teknis, bukan isi pesan.</li>
        </ul>
      </Section>
      <Section title="3. Untuk apa">
        <p>
          Untuk menjalankan layanan: membaca grup yang Anda pilih, merangkum, menjawab pertanyaan, mengirim pengingat, mengelola langganan, dan
          menjaga keamanan serta mutu layanan. Kami tidak menjual data Anda dan tidak memakainya untuk iklan.
        </p>
      </Section>
      <Section title="4. Dengan siapa data dibagikan">
        <ul className={list}>
          <li>Penyedia model AI pihak ketiga yang memproses teks pesan untuk membuat ringkasan dan jawaban.</li>
          <li>Layanan notifikasi peramban (Google, Apple, Mozilla, atau Microsoft) untuk pengingat pagi, berisi judul tenggat dan nama proyek, terenkripsi untuk perangkat Anda.</li>
          <li>Telegram, yang dipakai admin kami untuk mengelola layanan; pesan admin memuat nama studio, grup, dan nama serta nomor dari formulir permintaan akses, bukan isi percakapan.</li>
          <li>Penyedia infrastruktur dan jaringan (server dan Cloudflare) yang meneruskan lalu lintas ke layanan kami.</li>
        </ul>
        <p>Sebagian penyedia berada di luar Indonesia, sehingga data dapat diproses di luar negeri.</p>
      </Section>
      <Section title="5. Berapa lama disimpan">
        <ul className={list}>
          <li>Teks pesan: paling lama 90 hari, lalu dihapus. Bila sebuah keputusan atau tugas merujuk ke pesan itu, isi pesannya dikosongkan dan hanya rujukan yang tinggal.</li>
          <li>Grup yang Anda lepas dari pilihan: pesannya dihapus saat itu juga. Riwayat grup yang tidak Anda pilih dihapus dalam 24 jam.</li>
          <li>Percakapan di aplikasi dan jawaban terkirim: 90 hari.</li>
          <li>Hasil analisis (keputusan, tugas, tenggat, catatan proyek): selama Anda berlangganan.</li>
          <li>Setelah langganan berakhir dan masa tenggang 3 hari lewat, seluruh data Anda disimpan 30 hari lagi, lalu dihapus otomatis.</li>
          <li>Salinan cadangan sistem disimpan sampai 14 hari, sehingga data yang sudah dihapus dapat bertahan di cadangan selama itu.</li>
        </ul>
      </Section>
      <Section title="6. Hak Anda">
        <p>
          Anda berhak meminta akses, perbaikan, penghapusan, pembatasan, atau menarik persetujuan atas data pribadi Anda, serta mengajukan
          keberatan. Kirim permintaan ke {CONTACT}; penghapusan seluruh data akun kami lakukan secara manual dan Anda akan diberi tahu setelah
          selesai. Menarik persetujuan berarti layanan tidak dapat dilanjutkan.
        </p>
      </Section>
      <Section title="7. Keamanan">
        <p>
          Akses aplikasi memakai kode sekali pakai yang dikirim ke WhatsApp Anda; kode dan sesi disimpan dalam bentuk hash, data antar pelanggan
          dipisahkan, dan lalu lintas memakai HTTPS. Tidak ada sistem yang sepenuhnya aman; bila terjadi kebocoran yang berdampak pada Anda, kami
          akan memberi tahu sesuai ketentuan yang berlaku.
        </p>
      </Section>
      <Section title="8. Pihak yang Anda catat">
        <p>
          Pesan yang kami baca juga memuat data klien dan anggota grup Anda. Anda bertanggung jawab memiliki dasar yang sah untuk memakai Aksis
          pada percakapan tersebut.
        </p>
      </Section>
      <Section title="9. Perubahan">
        <p>Perubahan penting pada kebijakan ini akan diberitahukan di aplikasi atau lewat WhatsApp.</p>
      </Section>
    </Page>
  )
}

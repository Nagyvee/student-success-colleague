import type { Metadata } from 'next';
import VoucherClient from './VoucherClient';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'A voucher for you', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <VoucherClient code={decodeURIComponent(code)} />;
}

import { Suspense } from 'react';
import OfficeApp from '@/components/OfficeApp';

export default function Page() {
  return (
    <Suspense fallback={<div className="cz-boot">Opening the office…</div>}>
      <OfficeApp />
    </Suspense>
  );
}

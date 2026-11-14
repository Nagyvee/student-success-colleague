import type { Metadata } from 'next';
import LessonPlayer from './LessonPlayer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Your 3-minute lesson', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ quizId: string }> }) {
  const { quizId } = await params;
  return <LessonPlayer quizId={quizId} />;
}

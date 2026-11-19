import type { Metadata } from 'next';
import LessonPlayer from '../../learn/[quizId]/LessonPlayer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'A video made for you', robots: { index: false } };

/* A lead's programme video: the same player as the tutoring lessons, opened
 * with their signed link, greeting them by name and ending in their next step. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <LessonPlayer quizId="lead" lead={token} />;
}

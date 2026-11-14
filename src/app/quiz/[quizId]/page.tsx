import type { Metadata } from 'next';
import QuizPage from './QuizPage';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Your micro-quiz', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ quizId: string }> }) {
  const { quizId } = await params;
  return <QuizPage quizId={quizId} />;
}

import { VisitWorkspace } from '@/components/visit/VisitWorkspace';

export default async function VisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VisitWorkspace id={Number(id)} />;
}

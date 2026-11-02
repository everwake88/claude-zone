import { PatientProfile } from '@/components/patients/PatientProfile';

export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PatientProfile id={Number(id)} />;
}

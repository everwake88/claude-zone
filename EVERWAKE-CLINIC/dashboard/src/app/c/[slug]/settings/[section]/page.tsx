import { SettingsSection } from '@/components/settings/SettingsSection';

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  return <SettingsSection section={section} />;
}

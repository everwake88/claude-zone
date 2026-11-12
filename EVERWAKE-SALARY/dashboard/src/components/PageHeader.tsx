// The page's title (or the greeting on Overview), one line about it, and what it is doing right now.
export function PageHeader({ title, sub, crumb, live, actions }: {
  title: React.ReactNode; sub?: React.ReactNode; crumb?: React.ReactNode; live?: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <header className="head rise" style={{ ['--i' as string]: 0 }}>
      <div style={{ minWidth: 0 }}>
        {crumb}
        <h1>{title}{live}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {actions}
    </header>
  );
}

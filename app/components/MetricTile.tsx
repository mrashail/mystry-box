// A single KPI cell: a prominent tinted icon tile, a large number, a label,
// and an optional sub-detail. Shared by the dashboard and rules pages so every
// stat tile is visually identical.
export function MetricTile({
  icon,
  tone = "info",
  value,
  label,
  detail,
}: {
  icon: string;
  tone?: "success" | "info" | "auto";
  value: number;
  label: string;
  detail?: string;
}) {
  return (
    <s-stack direction="inline" gap="base" alignItems="center">
      <s-box
        padding="small-100"
        background="subdued"
        borderRadius="base"
        minInlineSize="44px"
        minBlockSize="44px"
      >
        <s-stack direction="inline" alignItems="center" justifyContent="center">
          <s-icon type={icon as any} tone={tone} size="base"></s-icon>
        </s-stack>
      </s-box>
      <s-stack direction="block" gap="small-500">
        <s-heading>{String(value)}</s-heading>
        <s-text color="subdued">{label}</s-text>
        {detail ? <s-text color="subdued">{detail}</s-text> : null}
      </s-stack>
    </s-stack>
  );
}

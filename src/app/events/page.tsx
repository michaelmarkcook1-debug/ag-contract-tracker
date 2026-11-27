import { Suspense } from "react";
import { EventsTable } from "@/components/market/EventsTable";

// EventsTable reads the link's filter (?family=, ?rumours=1) with useSearchParams, which needs a Suspense boundary on a
// prerendered page.
export default function EventsPage() {
  return (
    <Suspense fallback={null}>
      <EventsTable />
    </Suspense>
  );
}

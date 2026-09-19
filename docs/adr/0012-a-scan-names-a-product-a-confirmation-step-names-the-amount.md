# A scan names a product, a confirmation step names the amount

ADR-0011 assumed the gesture *is* the count: present a carton, one unit is recorded, present the
next. That reading makes the camera a faster keyboard, and it is only faster while every item is
physically presented to the lens.

A delivery is not shaped like that. Twenty-four identical boxes on a pallet is one product and one
number, and presenting each box in turn is twenty-four gestures to record something the warehouseman
knew at a glance. The camera was replacing the cheap half of the job — reading the code — and leaving
the expensive half, saying how many, to a form field that a modal covers.

## Decision

A camera scan resolves the barcode to a product and then **stops**. A confirmation step names the
amount, and nothing is recorded until it is answered. The step starts at one, so the single-item case
stays two taps.

The steppers move by one and by ten, and the amount can also be typed. `±10` exists because a pallet
of forty-eight is otherwise forty-seven taps; typing exists because an exact thirty-seven is
otherwise a lot of tens and ones. The controls are sized for a warehouse glove, which is also why the
steppers are the primary path and the field the fallback rather than the reverse — a glove finds a
large button reliably and a text caret badly.

**While the step is open the scanner accepts nothing.** Not a decode, not the manual-entry field, not
its keyboard shortcut. A question that can be scanned past is not a gate, and the failure it would
allow is a carton counted against the product named by the previous one.

This applies to the camera only. A typed or wedge-scanned code carries its quantity in the field
beside it on the same screen, already visible and already reachable, so interposing a step there
would be ceremony. The two paths still resolve and refuse a code on identical terms; they differ only
in where the amount comes from.

## ADR-0011 is not repealed

The repeat rule still decides when a code may count again, and the confirmation step makes it matter
more rather than less. After confirming, the carton is usually still in front of the lens — the
operator was looking at the screen, not at the pallet. Without the rule, resuming would immediately
raise the step again for the item just counted.

So the stream state is **frozen** while the step is open: neither a decode nor an empty frame is
observed, exactly as while a count is posting. Freezing rather than merely ignoring is the point. The
step can be open for as long as it takes to think, and a device lowered to tap `+10` shows the camera
an empty frame for far longer than the three ticks that mean "the carton left". Advancing the state
through that would clear the memory of what was just counted, and re-raising the device would present
a second carton that does not exist.

## Consequences

- One scan can now record any amount, so the log line and the pallet total carry more weight per
  gesture. A mis-tapped `+10` is a larger error than a duplicated scan ever was — which is why the
  confirm button states the number it is about to add rather than saying "Add".
- The step is rendered inside the scanner dialog rather than as a second modal. A separate dialog
  would unmount the `<video>` element holding the `MediaStream`, paying a fresh camera start per
  counted item; it would also nest two focus traps.
- Cancelling is free and always available: nothing is written until the step is answered, so a
  misread barcode costs a tap rather than a correction on the pallet.
- A count refused by the server leaves the step open with the chosen amount intact. Re-choosing
  twenty-four after a dropped connection is pure loss.
- The quantity field on the counting screen now serves the typed path alone, and blank still means
  one unit there.

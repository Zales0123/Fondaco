# A repeated scan counts again only after the code leaves the frame

Counting a delivery means presenting the same barcode to the camera over and over: twenty identical
cartons onto one pallet is the ordinary case, not an edge case. A scanner that stays on therefore has
to answer a question a one-shot scanner never asks — when does the same decoded value mean a second
item, and when is it the same item still sitting in front of the lens?

The answer is the physical motion. A decoded value that differs from the last accepted one is
accepted immediately. The same value is accepted again only after the frame has been observed
genuinely empty — the code leaving the lens — and a short cooldown has elapsed since the last
acceptance. Acceptance is suspended entirely while the count a scan produced is still being
recorded, so a slow round trip cannot queue items nobody presented.

"Genuinely empty" is several consecutive poll ticks, not one. A single tick that decodes nothing is
far more likely to be blur, glare or a hand crossing the lens than a carton that left, and any
decode resets the run, so an intermittently readable label never adds up to a departure. Treating
one bad look as departure would count a carton that never moved — receiving stock that never
arrived, silently.

The obvious alternative — ignore an identical code for a fixed window after each decode — was
rejected. It is right for a scanner that navigates somewhere and wrong for one that counts: the
cartons presented inside the window are silently not counted, and the resulting shortage is
indistinguishable from a short delivery. A rule that loses counts quietly is worse than one that
occasionally asks for a carton to be moved out of frame.

The two guards protect against opposite mistakes, which is why both exist. The sustained gap stops
one carton counting twice; the cooldown stops a flickering decode counting twice. Both errors are
silent, and an over-count is the worse of the two, because it receives stock the warehouse never
took in.

## Consequences

- Continuous scanning is an opt-in mode of the shared scanner dialog. A caller that resolves a code
  to a destination keeps the one-shot behavior, where stopping on the first decode is correct.
- Feedback per accepted scan is not decoration. The person holding the device is told which product
  was counted and what its new total is, because this rule is the only thing standing between a
  gesture and a number.
- A poll pass that decodes nothing is a signal rather than a failure, so an empty decode is never
  surfaced as an error.

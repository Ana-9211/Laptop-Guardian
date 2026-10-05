import 'react';

// React 18 does not know the `inert` attribute yet; it takes the empty string when set.
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> { inert?: '' }
}

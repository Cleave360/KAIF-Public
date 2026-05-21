import { happyPath }      from './happy-path.js'
import { expiredToken }   from './expired-token.js'
import { wrongAudience }  from './wrong-audience.js'
import { revokedJti }     from './revoked-jti.js'
import { cnfMismatch }    from './cnf-mismatch.js'
import { scopeOverreach } from './scope-overreach.js'
import { delegationDepth } from './delegation-depth.js'
import type { ConformanceFixture } from '../types.js'

export const allFixtures: ConformanceFixture[] = [
  happyPath,
  expiredToken,
  wrongAudience,
  revokedJti,
  cnfMismatch,
  scopeOverreach,
  delegationDepth,
]

export {
  happyPath,
  expiredToken,
  wrongAudience,
  revokedJti,
  cnfMismatch,
  scopeOverreach,
  delegationDepth,
}

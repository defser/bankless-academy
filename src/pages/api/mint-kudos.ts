/* eslint-disable no-console */
import { NextApiRequest, NextApiResponse } from 'next'
import axios from 'axios'

import { db, TABLE, TABLES, getUserId } from 'utils/db'
import { LESSONS, GENERIC_ERROR_MESSAGE } from 'constants/index'
import {
  MINTKUDOS_API,
  MINTKUDOS_ENCODED_STRING,
  MINTKUDOS_COMMUNITY_ID,
} from 'constants/kudos'
import { KudosType } from 'entities/kudos'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<void> {
  // check params + signature
  const { address, kudosId, message } = req.body
  console.log(req)
  if (!address || !kudosId || typeof address === 'object')
    return res.json({ error: 'Wrong params' })

  console.log('address: ', address)
  console.log('kudosId: ', kudosId)
  // console.log('signature: ', signature)
  console.log('message: ', message)

  try {
    const userId = await getUserId(address)
    console.log(userId)
    if (!(userId && Number.isInteger(userId)))
      return res.json({ error: 'userId not found' })

    const notionId = LESSONS.find(
      (lesson) => lesson.kudosId === kudosId
    )?.notionId
    if (!notionId) return res.json({ error: 'notionId not found' })

    const [credential] = await db(TABLES.credentials)
      .select('id')
      .where(TABLE.credentials.notion_id, notionId)
    if (!credential) return res.json({ error: 'credentialId not found' })

    const [questCompleted] = await db(TABLES.completions)
      .select(TABLE.completions.id, TABLE.completions.credential_claimed_at)
      .where(TABLE.completions.credential_id, credential.id)
      .where(TABLE.completions.user_id, userId)

    let questStatus = ''
    if (kudosId && !questCompleted?.credential_claimed_at) {
      // Sybil check with Academy Passport
      const passport = await axios.get(
        `${req.headers.origin}/api/passport?address=${address}`
      )
      if (!passport.data.verified) {
        return res.json({
          status: `Passport requirement: ${passport.data.requirement}`,
        })
      }

      const userKudos = await axios.get(
        `${MINTKUDOS_API}/v1/wallets/${address}/tokens?limit=100&communityId=${MINTKUDOS_COMMUNITY_ID}`
      )
      // console.log('userKudos', userKudos?.data?.data)

      const findKudos: KudosType = userKudos?.data?.data.find(
        (kudos: KudosType) => kudos.kudosTokenId === kudosId
      )

      if (findKudos) {
        const isKudosAlreadyClaimed = findKudos.claimStatus === 'claimed'
        if (isKudosAlreadyClaimed) {
          const updated = await db(TABLES.completions)
            .where(TABLE.completions.id, questCompleted.id)
            .update({ credential_claimed_at: findKudos.createdAt })
          console.log('updated', updated)
          if (updated) {
            questStatus = 'updated credential_claimed_at'
            console.log(questStatus)
            return res.json({ status: questStatus })
          }
        }
        questStatus = 'address already on allowlist'
        console.log(questStatus)
        return res.json({ status: questStatus })
      } else {
        const [{ signature }] = await db(TABLES.credentials)
          .select('signature')
          .where('notion_id', notionId)
        if (!signature) return res.json({ error: 'signature not found' })

        try {
          const bodyParameters = {
            contributors: [address],
            signature: signature,
          }
          const config = {
            headers: {
              Authorization: `Basic ${MINTKUDOS_ENCODED_STRING}`,
            },
          }
          // add address to allowlist
          console.log('add address to allowlist:', bodyParameters)
          const result = await axios.post(
            `${MINTKUDOS_API}/v1/tokens/${kudosId}/addContributors`,
            bodyParameters,
            config
          )
          if (result.status === 202) {
            console.log(result.headers.location)
            return res.json({
              location: `${MINTKUDOS_API}${result.headers?.location}`,
              status: questStatus,
            })
          } else {
            console.log(result)
            return res.json({
              error: 'something went wrong during allowlist add',
              status: questStatus,
            })
          }
        } catch (error) {
          console.error(error?.response?.data)
        }
      }
    } else if (kudosId && questCompleted?.credential_claimed_at) {
      questStatus = 'already minted'
    } else {
      questStatus = 'kudosID not found'
    }
    return res.json({ status: questStatus })
  } catch (error) {
    console.error(error)
    res.json({
      error: `error ${error?.code}: ${GENERIC_ERROR_MESSAGE}`,
    })
  }
}
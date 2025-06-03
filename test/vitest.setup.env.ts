import dotenv from 'dotenv'

export const setup = async (): Promise<void> => {
  dotenv.config({ path: 'test/test.env' })
}

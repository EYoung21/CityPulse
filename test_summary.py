import asyncio
from philly_pulse.server import summary
from fastapi import Response

async def main():
    try:
        res = await summary(Response())
        print(res)
    except Exception as e:
        print("ERROR:", type(e), e)

asyncio.run(main())

import aioble
import bluetooth
import asyncio
from sys import exit

# Bluetooth parameters
BLE_NAME = "RECEIVER"  # You can dynamically change this if you want unique names
BLE_SVC_UUID = bluetooth.UUID(0x181A)
BLE_CHARACTERISTIC_UUID = bluetooth.UUID(0x2A6E)
BLE_APPEARANCE = 0x0300
BLE_ADVERTISING_INTERVAL = 2000
BLE_SCAN_LENGTH = 5000
BLE_INTERVAL = 30000
BLE_WINDOW = 30000

def decode_message(message):
    """ Decode a message from bytes """
    return message.decode('utf-8')

async def receive_data_task(characteristic):
    """ Receive data from the connected device """
    global message_count
    while True:
        try:
            data = await characteristic.read()
            rMessage = decode_message(data) #rMeassage means Received Message
            
            if data:
                print(rMessage)
                pairs = rMessage.split(',')
                baseline = float(pairs[0].split('=')[1])
                vref = float(pairs[1].split('=')[1])
                reading = float(pairs[2].split('=')[1])
                print(f"Baseline={baseline},Vref={vref},Reading={reading}")
                await asyncio.sleep(0.5)

        except asyncio.TimeoutError:
            print("Timeout waiting for data in {ble_name}.")
            break
        except Exception as e:
            print(f"Error receiving data: {e}")
            break

async def run_receiver_mode():
    """ Run the receiver mode """

    # Start scanning for a device with the matching service UUID
    while True:
        device = await ble_scan()

        if device is None:
            continue
        print(f"device is: {device}, name is {device.name()}")

        try:
            print(f"Connecting to {device.name()}")
            connection = await device.device.connect()

        except asyncio.TimeoutError:
            print("Timeout during connection")
            continue

        print(f"RECEIVER connected to {connection}")

        # Discover services
        async with connection:
            try:
                service = await connection.service(BLE_SVC_UUID)
                characteristic = await service.characteristic(BLE_CHARACTERISTIC_UUID)
            except (asyncio.TimeoutError, AttributeError):
                print("Timed out discovering services/characteristics")
                continue
            except Exception as e:
                print(f"Error discovering services {e}")
                await connection.disconnect()
                continue

            tasks = [
                asyncio.create_task(receive_data_task(characteristic)),
            ]
            await asyncio.gather(*tasks)

            await connection.disconnected()
            print(f"{BLE_NAME} disconnected from {device.name()}")
            break

async def ble_scan():
    """ Scan for a BLE device with the matching service UUID """

    print(f"Scanning for BLE Beacon named {BLE_NAME}...")

    async with aioble.scan(5000, interval_us=30000, window_us=30000, active=True) as scanner:
        async for result in scanner:
            try:
                name = result.name()
            except UnicodeError:
                name = None
            if name == "TRANSMITTER" and BLE_SVC_UUID in result.services():
                print(f"found {name} with service uuid {BLE_SVC_UUID}")
                return result
    return None

async def main():
    """ Main function """
    while True:
        tasks = [
            asyncio.create_task(run_receiver_mode()),
        ]

        await asyncio.gather(*tasks)

asyncio.run(main())


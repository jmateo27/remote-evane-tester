import machine
import time
import aioble
import bluetooth
import asyncio

ENABLE_LATENCY_S = 1.0
MEASUREMENT_LATENCY_MS = 1000

class Enable_Interface:
    ENABLE_PIN = 16
    ENABLE_RISE_TIME_S = 0.1
    def __init__(self):
        self.pin = machine.Pin(self.ENABLE_PIN, machine.Pin.OUT, value=0)
    
    def on(self):
        self.pin.value(1)

    def off(self):
        self.pin.value(0)

class ADC_Interface:
    VANE_READING_PIN = 28
    VREF_READING_PIN = 27

    # Constants for ADC conversion
    ADC_MAX_VOLTAGE = 3.3        # Reference voltage for ADC (typically 3.3V on RP2040)
    ADC_MAX_READING = 0xFFFF     # 16-bit maximum value for ADC (65535)

    def __init__(self):
        self.vane_adc = machine.ADC(self.VANE_READING_PIN)
        self.vref_adc = machine.ADC(self.VREF_READING_PIN)

    def measure_vane(self):
        return self.vane_adc.read_u16() * self.ADC_MAX_VOLTAGE / self.ADC_MAX_READING

    def measure_vref(self):
        return self.vref_adc.read_u16() * self.ADC_MAX_VOLTAGE / self.ADC_MAX_READING
    
class Main_Bluetooth_Transmission:

    # Bluetooth parameters
    BLE_NAME = "TRANSMITTER"
    BLE_SVC_UUID = bluetooth.UUID(0x181A)
    BLE_CHARACTERISTIC_UUID = bluetooth.UUID(0x2A6E)
    BLE_APPEARANCE = 0x0300
    BLE_ADVERTISING_INTERVAL = 2000
    BLE_SCAN_LENGTH = 5000
    BLE_INTERVAL = 30000
    BLE_WINDOW = 30000

    SEND_LATENCY_S = 0.4

    def __init__(self):
        self.enable = Enable_Interface()
        self.adcs = ADC_Interface()
        self.enable.off()
        time.sleep(3)
        self.enable.on()
        time.sleep(self.enable.ENABLE_RISE_TIME_S)
        self.vane_init = self.adcs.measure_vane()
        self.vref_init = self.adcs.measure_vref()
        self.enable.off()

    def encode_message(self, message):
        """ Encode a message to bytes """
        return message.encode('utf-8')
    
    async def send_data_task(self, connection, characteristic):
        """ Send data to the connected device """
        iter = 0
        while True:
            if not connection:
                print("error - no connection in send data")
                continue

            if not characteristic:
                print("error no characteristic provided in send data")
                continue
            
            # Determine the message depending on the shared variable
            self.enable.on()
            await asyncio.sleep(self.enable.ENABLE_RISE_TIME_S)
            if iter == 0:
                sMessage = "V{:.6f},{:.6f}".format(self.adcs.measure_vref(), self.adcs.measure_vane())
            else:
                sMessage = "B{:.6f},{:.6f}".format(self.vane_init, self.adcs.measure_vane())
            self.enable.off()
            iter = (iter+1)%3

            print(f'Sending message: {sMessage}')

            try:
                msg = self.encode_message(sMessage)
                characteristic.write(msg)
                
            except Exception as e:
                print(f"writing error {e}")
                continue

            await asyncio.sleep(self.SEND_LATENCY_S)

    async def run_transmitter_mode(self):
        """ Run the transmitter mode """

        # Set up the Bluetooth service and characteristic
        ble_service = aioble.Service(self.BLE_SVC_UUID)
        characteristic = aioble.Characteristic(
            ble_service,
            self.BLE_CHARACTERISTIC_UUID,
            read=True,
            notify=True,
            write=True,
            capture=True,
        )
        aioble.register_services(ble_service)

        print(f"{self.BLE_NAME} starting to advertise")

        while True:
            async with await aioble.advertise(
                self.BLE_ADVERTISING_INTERVAL,
                name=self.BLE_NAME,
                services=[self.BLE_SVC_UUID],
                appearance=self.BLE_APPEARANCE) as connection:
                print(f"{self.BLE_NAME} connected to another device: {connection.device}")

                tasks = [
                    asyncio.create_task(self.send_data_task(connection, characteristic)),
                ]
                await asyncio.gather(*tasks)
                print(f"{self.BLE_NAME} disconnected")
                break

async def main():
    btTransmit = Main_Bluetooth_Transmission()
    while True:
        tasks = [
            asyncio.create_task(btTransmit.run_transmitter_mode()),
        ]
        await asyncio.gather(*tasks)

if __name__ == "__main__":
    asyncio.run(main())
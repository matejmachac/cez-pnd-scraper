from deploy.native_deploy import transport_url


def test_supervisor_registered_dns_is_used_instead_of_container_hostname():
    assert (
        transport_url(
            {
                "hostname": "a894bec6-cez-pnd-scraper",
                "dns": ["a894bec6-cez-pnd-scraper.local.hass.io"],
            }
        )
        == "http://a894bec6-cez-pnd-scraper.local.hass.io:8099"
    )
